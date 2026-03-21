import { randomUUID } from "node:crypto";
import alchemy from "alchemy";
import type { AgentSpawn } from "../shared/session.js";
import type { AgentTemplateRuntime } from "../shared/session.js";
import type { AcpTransport } from "./transport.js";
import { findFreePort, openLocalTransport, openTcpTransport } from "./transport.js";

export type StartedRuntime = {
  transport: AcpTransport;
  terminate: () => Promise<void>;
  reconnect?: () => Promise<AcpTransport>;
};

export type RuntimeProviderStartRequest = {
  runtime: AgentTemplateRuntime;
  spawn: AgentSpawn;
};

export type RuntimeProvider = {
  start(request: RuntimeProviderStartRequest): Promise<StartedRuntime>;
  reconnect?: (request: RuntimeProviderStartRequest) => Promise<AcpTransport>;
};

export type RuntimeProviderRegistry = Record<string, RuntimeProvider>;

let alchemyReady: Promise<void> | null = null;

async function ensureAlchemy(): Promise<void> {
  if (!alchemyReady) {
    alchemyReady = alchemy("flamecast", { phase: "up", quiet: true }).then(() => undefined);
  }
  await alchemyReady;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function waitForAcp(
  host: string,
  port: number,
  timeoutMs = readPositiveIntEnv("FLAMECAST_ACP_WAIT_TIMEOUT_MS", 30_000),
): Promise<void> {
  const { createConnection } = await import("node:net");
  const retryDelayMs = readPositiveIntEnv("FLAMECAST_ACP_WAIT_RETRY_MS", 200);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const onError = (error: Error) => {
          clearTimeout(timeout);
          socket.destroy();
          reject(error);
        };
        const socket = createConnection({ host, port }, () => {
          timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error("timeout"));
          }, 2000);
          socket.setNoDelay(true);
          const msg =
            JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              method: "initialize",
              params: { protocolVersion: 1, clientCapabilities: {} },
            }) + "\n";

          socket.once("data", () => {
            clearTimeout(timeout);
            socket.off("error", onError);
            socket.destroy();
            resolve();
          });

          socket.write(msg);
        });
        socket.once("error", onError);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(`ACP agent not ready on ${host}:${port} after ${timeoutMs}ms`);
}

function createLocalRuntimeProvider(): RuntimeProvider {
  return {
    async start({ spawn }) {
      const transport = openLocalTransport(spawn);
      return {
        transport,
        terminate: async () => {
          await transport.dispose?.();
        },
      };
    },
  };
}

function createDockerRuntimeProvider(): RuntimeProvider {
  return {
    async start({ runtime }) {
      await ensureAlchemy();

      const provider = await import("alchemy/docker");
      const port = await findFreePort();
      const resourceId = randomUUID();

      if (runtime.image && runtime.dockerfile) {
        await provider.Image(`agent-image-${resourceId}`, {
          name: runtime.image,
          tag: "latest",
          build: { context: ".", dockerfile: runtime.dockerfile },
          skipPush: true,
        });
      }

      await provider.Container(`sandbox-${resourceId}`, {
        image: runtime.image ? `${runtime.image}:latest` : "node:20",
        name: `flamecast-sandbox-${resourceId}`,
        environment: { ACP_PORT: String(port) },
        ports: [{ external: port, internal: port }],
        start: true,
      });

      await waitForAcp("localhost", port);

      const transport = await openTcpTransport("localhost", port);

      return {
        transport,
        terminate: async () => {
          await transport.dispose?.();
        },
      };
    },
  };
}

export function createBuiltinRuntimeProviders(): RuntimeProviderRegistry {
  return {
    local: createLocalRuntimeProvider(),
    docker: createDockerRuntimeProvider(),
  };
}

export function resolveRuntimeProviders(
  overrides: RuntimeProviderRegistry = {},
): RuntimeProviderRegistry {
  return {
    ...createBuiltinRuntimeProviders(),
    ...overrides,
  };
}
