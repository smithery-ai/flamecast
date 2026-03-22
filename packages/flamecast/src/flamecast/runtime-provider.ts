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
  /** Unique ID for the session, used to namespace provisioned resources. */
  sessionId: string;
};

export type RuntimeProvider = {
  start(request: RuntimeProviderStartRequest): Promise<StartedRuntime>;
  reconnect?: (request: RuntimeProviderStartRequest) => Promise<AcpTransport>;
};

export type RuntimeProviderRegistry = Record<string, RuntimeProvider>;

type WaitForAcpOptions = {
  timeoutMs?: number;
  probeTimeoutMs?: number;
  retryDelayMs?: number;
};

type BuiltinRuntimeProviderOptions = {
  acpReadyTimeoutMs?: number;
  acpProbeTimeoutMs?: number;
  acpRetryDelayMs?: number;
};

const resourceScope = alchemy("flame-resources", { quiet: true });

function resolveDockerBuildContext(dockerfile: string): string {
  const dockerfileDir = dirname(dockerfile);
  return basename(dockerfileDir) === "docker" ? resolve(dockerfileDir, "..") : dockerfileDir;
}

async function waitForAcp(
  host: string,
  port: number,
  { timeoutMs = 30_000, probeTimeoutMs = 2_000, retryDelayMs = 200 }: WaitForAcpOptions = {},
): Promise<void> {
  const { createConnection } = await import("node:net");
  const effectiveProbeTimeoutMs = Math.min(probeTimeoutMs, timeoutMs);
  const effectiveRetryDelayMs = Math.min(retryDelayMs, timeoutMs);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: ReturnType<typeof createConnection> | undefined;

    const cleanupSocket = () => {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
      }

      /* v8 ignore next -- defensive when cleanup runs before a socket exists */
      if (!socket) {
        return;
      }

      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.destroy();
      socket = undefined;
    };

    const finish = (callback: () => void) => {
      /* v8 ignore next -- defensive against duplicate completion */
      if (settled) {
        return;
      }

      settled = true;

      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }

      clearTimeout(deadlineTimer);
      cleanupSocket();
      callback();
    };

    const scheduleRetry = () => {
      /* v8 ignore next -- defensive against late timer callbacks after settle */
      if (settled) {
        return;
      }

      cleanupSocket();
      retryTimer = setTimeout(connect, effectiveRetryDelayMs);
    };

    const connect = () => {
      /* v8 ignore next -- defensive against late retry timers after settle */
      if (settled) {
        return;
      }

      const attemptSocket = createConnection({ host, port }, () => {
        /* v8 ignore next -- defensive against late socket callbacks after cleanup */
        if (settled || socket !== attemptSocket) {
          return;
        }

        handshakeTimer = setTimeout(scheduleRetry, effectiveProbeTimeoutMs);
        attemptSocket.setNoDelay(true);
        attemptSocket.once("data", () => finish(resolve));
        attemptSocket.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: 1, clientCapabilities: {} },
          }) + "\n",
        );
      });

      socket = attemptSocket;
      attemptSocket.once("error", () => {
        /* v8 ignore next -- defensive against late socket errors after cleanup */
        if (settled || socket !== attemptSocket) {
          return;
        }

        scheduleRetry();
      });
    };

    const deadlineTimer = setTimeout(() => {
      finish(() =>
        reject(new Error(`ACP agent not ready on ${host}:${port} after ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    connect();
  });
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

function createDockerRuntimeProvider(options: BuiltinRuntimeProviderOptions = {}): RuntimeProvider {
  return {
    async start({ runtime, sessionId }) {
      await resourceScope;

      return alchemy.run(`session-${sessionId}`, async (scope) => {
        const provider = await import("alchemy/docker");
        const port = await findFreePort();
        const image = runtime.image;

        if (!image) {
          throw new Error('Docker runtime requires an "image" value');
        }

        if (runtime.dockerfile) {
          const dockerfile = runtime.dockerfile;
          await provider.Image("image", {
            name: image,
            tag: "latest",
            build: {
              context: resolveDockerBuildContext(dockerfile),
              dockerfile,
            },
            skipPush: true,
          });
        }

        await provider.Container("sandbox", {
          image: `${image}:latest`,
          name: `flamecast-sandbox-${sessionId}`,
          environment: { ACP_PORT: String(port) },
          ports: [{ external: port, internal: port }],
          start: true,
        });

        await waitForAcp("localhost", port, {
          timeoutMs: options.acpReadyTimeoutMs,
          probeTimeoutMs: options.acpProbeTimeoutMs,
          retryDelayMs: options.acpRetryDelayMs,
        });

        const transport = await openTcpTransport("localhost", port);

        return {
          transport,
          terminate: async () => {
            await transport.dispose?.();
            await alchemy.destroy(scope).catch(() => undefined);
          },
        };
      });
    },
  };
}

export function createBuiltinRuntimeProviders(
  options: BuiltinRuntimeProviderOptions = {},
): RuntimeProviderRegistry {
  return {
    local: createLocalRuntimeProvider(),
    docker: createDockerRuntimeProvider(options),
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
