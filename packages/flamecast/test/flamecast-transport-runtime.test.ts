/* eslint-disable no-type-assertion/no-type-assertion */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";

class FakeSocket extends EventEmitter {
  readonly destroy = vi.fn();
  readonly end = vi.fn();
  readonly setNoDelay = vi.fn();
  readonly write = vi.fn((chunk: Uint8Array, callback?: (error?: Error | null) => void) => {
    callback?.(null);
    return true;
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("transport helpers", () => {
  test("spawns local agents and converts stdio to ACP transport", async () => {
    const kill = vi.fn();
    const agentProcess = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill,
    };
    const spawn = vi.fn(() => agentProcess);

    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn,
      };
    });

    const transport = await import("../src/flamecast/transport.js");
    const started = transport.startAgentProcess({ command: "node", args: ["agent.js"] });
    const startedWithDefaultArgs = transport.startAgentProcess({ command: "node" });
    expect(started).toBe(agentProcess);
    expect(startedWithDefaultArgs).toBe(agentProcess);

    const local = transport.openLocalTransport({ command: "node", args: ["agent.js"] });
    local.kill();
    await local.dispose?.();

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "node",
      [],
      expect.objectContaining({ stdio: ["pipe", "pipe", "inherit"] }),
    );
    expect(kill).toHaveBeenCalledTimes(2);

    expect(() =>
      transport.getAgentTransport({
        stdin: null,
        stdout: null,
      } as unknown as Parameters<typeof transport.getAgentTransport>[0]),
    ).toThrow("Failed to get stdin/stdout from agent process");
  });

  test("opens tcp transports, waits for ports, and finds free ports", async () => {
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        socket.write(Buffer.concat([Buffer.from("ack:"), chunk]));
        socket.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    const { findFreePort, openTcpTransport, waitForPort } =
      await import("../src/flamecast/transport.js");

    await waitForPort("127.0.0.1", address.port, 1_200);
    const tcp = await openTcpTransport("127.0.0.1", address.port);
    const writer = tcp.input.getWriter();
    const reader = tcp.output.getReader();

    await writer.write(new Uint8Array(Buffer.from("hello")));
    const firstChunk = await reader.read();
    expect(Buffer.from(firstChunk.value ?? new Uint8Array())).toEqual(Buffer.from("ack:hello"));
    expect((await reader.read()).done).toBe(true);

    await writer.close();
    await tcp.dispose?.();
    reader.releaseLock();
    await closeServer(server);

    const delayedPort = await findFreePort();
    const delayedServer = createServer();
    setTimeout(() => {
      delayedServer.listen(delayedPort, "127.0.0.1");
    }, 10);
    await waitForPort("127.0.0.1", delayedPort, 1_200);
    await closeServer(delayedServer);

    const closedPort = await findFreePort();
    await expect(openTcpTransport("127.0.0.1", closedPort)).rejects.toThrow();
    await expect(waitForPort("127.0.0.1", closedPort, 25)).rejects.toThrow(
      `Port ${closedPort} not ready after 25ms`,
    );

    const cancelServer = createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", () => {
        socket.write(Buffer.from("cancel"));
      });
    });
    await new Promise<void>((resolve) => cancelServer.listen(0, "127.0.0.1", () => resolve()));
    const cancelAddress = cancelServer.address();
    if (!cancelAddress || typeof cancelAddress === "string") {
      throw new Error("Expected cancel test TCP server address");
    }

    const cancellable = await openTcpTransport("127.0.0.1", cancelAddress.port);
    const cancelWriter = cancellable.input.getWriter();
    const cancelReader = cancellable.output.getReader();
    await cancelWriter.write(new Uint8Array(Buffer.from("x")));
    await cancelReader.cancel();
    await cancellable.dispose?.();
    await closeServer(cancelServer);
  });
});

describe("runtime providers", () => {
  test("creates builtin local and docker runtime providers and caches alchemy init", async () => {
    const openLocalTransport = vi.fn(() => ({
      input: new WritableStream<Uint8Array>(),
      output: new ReadableStream<Uint8Array>(),
      dispose: vi.fn(async () => {}),
    }));
    const openTcpTransport = vi.fn(async () => ({
      input: new WritableStream<Uint8Array>(),
      output: new ReadableStream<Uint8Array>(),
      dispose: vi.fn(async () => {}),
    }));
    const findFreePort = vi.fn(async () => 4321);
    const alchemy = vi.fn(async () => {});
    const Image = vi.fn(async () => {});
    const Container = vi.fn(async () => ({ id: "container-1" }));
    const createConnection = vi.fn((_opts: unknown, onConnect: () => void) => {
      const socket = new FakeSocket();
      queueMicrotask(() => {
        onConnect();
      });
      socket.write.mockImplementation((_chunk, callback) => {
        socket.emit("data", Buffer.from("{}"));
        callback?.(null);
        return true;
      });
      return socket;
    });

    vi.doMock("../src/flamecast/transport.js", () => ({
      openLocalTransport,
      openTcpTransport,
      findFreePort,
    }));
    vi.doMock("alchemy", () => ({
      default: alchemy,
    }));
    vi.doMock("alchemy/docker", () => ({
      Image,
      Container,
    }));
    vi.doMock("node:net", async () => {
      const actual = await vi.importActual<typeof import("node:net")>("node:net");
      return {
        ...actual,
        createConnection,
      };
    });

    const runtimeProvider = await import("../src/flamecast/runtime-provider.js");
    const providers = runtimeProvider.createBuiltinRuntimeProviders();

    const local = await providers.local.start({
      runtime: { provider: "local" },
      spawn: { command: "node", args: ["agent.js"] },
    });
    expect(local.transport).toMatchObject({
      input: expect.any(WritableStream),
      output: expect.any(ReadableStream),
    });
    await local.terminate();

    const docker = providers.docker;
    const withBuild = await docker.start({
      runtime: {
        provider: "docker",
        image: "flamecast/example-agent",
        dockerfile: "Dockerfile",
      },
      spawn: { command: "node", args: ["agent.js"] },
    });
    const withDockerDirBuild = await docker.start({
      runtime: {
        provider: "docker",
        image: "flamecast/example-agent",
        dockerfile: "docker/Dockerfile",
      },
      spawn: { command: "node", args: ["agent.js"] },
    });
    const withoutBuild = await docker.start({
      runtime: {
        provider: "docker",
        image: "flamecast/example-agent",
      },
      spawn: { command: "node", args: ["agent.js"] },
    });

    await withBuild.terminate();
    await withDockerDirBuild.terminate();
    await withoutBuild.terminate();

    expect(alchemy).toHaveBeenCalledTimes(1);
    expect(findFreePort).toHaveBeenCalledTimes(3);
    expect(openLocalTransport).toHaveBeenCalledWith({ command: "node", args: ["agent.js"] });
    expect(Image).toHaveBeenCalledTimes(2);
    expect(Image).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        build: expect.objectContaining({
          dockerfile: "docker/Dockerfile",
        }),
      }),
    );
    expect(Container).toHaveBeenCalledTimes(3);
    expect(openTcpTransport).toHaveBeenCalledWith("localhost", 4321);
    expect(runtimeProvider.resolveRuntimeProviders({ custom: providers.local })).toMatchObject({
      local: expect.any(Object),
      docker: expect.any(Object),
      custom: expect.any(Object),
    });
  });

  test("times out while waiting for ACP when the socket never becomes ready", async () => {
    const openTcpTransport = vi.fn();
    const findFreePort = vi.fn(async () => 4545);
    const alchemy = vi.fn(async () => {});
    const Container = vi.fn(async () => ({ id: "container-1" }));
    let attempts = 0;
    const emitRefused = (socket: FakeSocket) => {
      if (socket.listenerCount("error") === 0) {
        return;
      }

      socket.emit("error", new Error("refused"));
    };
    const createConnection = vi.fn((_options: unknown, onConnect?: () => void) => {
      attempts += 1;
      const socket = new FakeSocket();
      if (attempts === 1) {
        queueMicrotask(() => {
          onConnect?.();
        });
      } else if (attempts === 2) {
        queueMicrotask(() => {
          onConnect?.();
          setTimeout(() => {
            emitRefused(socket);
          }, 5);
        });
      } else {
        setTimeout(() => {
          emitRefused(socket);
        }, 5);
      }
      return socket;
    });

    vi.doMock("../src/flamecast/transport.js", () => ({
      openLocalTransport: vi.fn(),
      openTcpTransport,
      findFreePort,
    }));
    vi.doMock("alchemy", () => ({
      default: alchemy,
    }));
    vi.doMock("alchemy/docker", () => ({
      Container,
    }));
    vi.doMock("node:net", async () => {
      const actual = await vi.importActual<typeof import("node:net")>("node:net");
      return {
        ...actual,
        createConnection,
      };
    });

    const { createBuiltinRuntimeProviders } = await import("../src/flamecast/runtime-provider.js");
    await expect(
      createBuiltinRuntimeProviders({
        acpReadyTimeoutMs: 40,
        acpProbeTimeoutMs: 10,
        acpRetryDelayMs: 5,
      }).docker.start({
        runtime: { provider: "docker", image: "flamecast/example-agent" },
        spawn: { command: "node", args: ["agent.js"] },
      }),
    ).rejects.toThrow("ACP agent not ready on localhost:4545 after 40ms");

    expect(Container).toHaveBeenCalledTimes(1);
    expect(openTcpTransport).not.toHaveBeenCalled();
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  test('requires docker runtimes to provide an "image"', async () => {
    const alchemy = vi.fn(async () => {});
    const findFreePort = vi.fn(async () => 4321);

    vi.doMock("alchemy", () => ({
      default: alchemy,
    }));
    vi.doMock("alchemy/docker", () => ({
      Container: vi.fn(async () => ({ id: "container-1" })),
      Image: vi.fn(async () => {}),
    }));
    vi.doMock("../src/flamecast/transport.js", () => ({
      findFreePort,
      openLocalTransport: vi.fn(),
      openTcpTransport: vi.fn(),
    }));

    const { createBuiltinRuntimeProviders } = await import("../src/flamecast/runtime-provider.js");

    await expect(
      createBuiltinRuntimeProviders().docker.start({
        runtime: { provider: "docker" },
        spawn: { command: "node", args: ["agent.js"] },
      }),
    ).rejects.toThrow('Docker runtime requires an "image" value');
  });
});
