import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { basename, dirname, resolve } from "node:path";
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

function resolveDockerBuildContext(dockerfile: string): string {
  const dockerfileDir = dirname(dockerfile);
  return basename(dockerfileDir) === "docker" ? resolve(dockerfileDir, "..") : dockerfileDir;
}

async function ensureAlchemy(): Promise<void> {
  if (!alchemyReady) {
    alchemyReady = alchemy("flamecast", { phase: "up", quiet: true }).then(() => undefined);
  }
  await alchemyReady;
}

async function waitForAcp(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const initializeMessage =
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    }) + "\n";

  while (Date.now() < deadline) {
    const remaining = Math.max(deadline - Date.now(), 0);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => {
            cleanup();
            socket.destroy();
            reject(new Error("timeout"));
          },
          Math.min(2_000, remaining),
        );

        const cleanup = () => {
          clearTimeout(timeout);
          socket.off("data", onData);
          socket.off("error", onError);
        };

        const onData = () => {
          cleanup();
          socket.destroy();
          resolve();
        };

        const onError = (error: Error) => {
          cleanup();
          socket.destroy();
          reject(error);
        };

        const socket = createConnection({ host, port }, () => {
          socket.setNoDelay(true);
          socket.write(initializeMessage);
        });

        socket.once("data", onData);
        socket.once("error", onError);
      });
      return;
    } catch {
      const sleepMs = Math.min(200, Math.max(deadline - Date.now(), 0));
      if (sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
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
      const image = runtime.image;

      if (!image) {
        throw new Error('Docker runtime requires an "image" value');
      }

      if (runtime.dockerfile) {
        const dockerfile = runtime.dockerfile;
        await provider.Image(`agent-image-${resourceId}`, {
          name: image,
          tag: "latest",
          build: {
            context: resolveDockerBuildContext(dockerfile),
            dockerfile,
          },
          skipPush: true,
        });
      }

      await provider.Container(`sandbox-${resourceId}`, {
        image: `${image}:latest`,
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
