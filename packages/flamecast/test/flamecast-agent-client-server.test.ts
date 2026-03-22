/* oxlint-disable no-type-assertion/no-type-assertion */
import { EventEmitter } from "node:events";
import readline from "node:readline/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ExampleClient } from "../src/flamecast/client.js";
import { ExampleAgent, toUint8ReadableStream } from "../src/flamecast/agent.js";

const flamecastSourceEntry = "../../../packages/flamecast/src/index.js";

function createPermissionRequest(): acp.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      title: "Modify config",
      kind: "edit",
      status: "pending",
      rawInput: {},
    },
    options: [
      {
        optionId: "allow",
        name: "Allow",
        kind: "allow_once",
      },
      {
        optionId: "reject",
        name: "Reject",
        kind: "reject_once",
      },
    ],
  };
}

function getPrivateMethod<Args extends unknown[], Result>(
  target: object,
  name: string,
): (...args: Args) => Result {
  const method = Reflect.get(target, name);
  if (typeof method !== "function") {
    throw new Error(`Expected ${name} to be a function`);
  }
  return method.bind(target) as (...args: Args) => Result;
}

class FakeSocket extends EventEmitter {
  readonly setNoDelay = vi.fn();
  readonly destroy = vi.fn();
  readonly end = vi.fn();
  readonly write = vi.fn((chunk: Uint8Array, callback?: (error?: Error | null) => void) => {
    callback?.(null);
    this.emit("data", Buffer.from(chunk));
    this.emit("end");
    return true;
  });
}

afterEach(() => {
  delete process.env.ACP_PORT;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("example client", () => {
  test("loops until the user selects a valid permission option", async () => {
    const createInterface = vi
      .spyOn(readline, "createInterface")
      .mockReturnValueOnce({
        question: vi.fn(async () => "0"),
        close: vi.fn(),
      } as unknown as ReturnType<typeof readline.createInterface>)
      .mockReturnValueOnce({
        question: vi.fn(async () => "2"),
        close: vi.fn(),
      } as unknown as ReturnType<typeof readline.createInterface>);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const client = new ExampleClient();
    const response = await client.requestPermission(createPermissionRequest());

    expect(response).toEqual({
      outcome: { outcome: "selected", optionId: "reject" },
    });
    expect(createInterface).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("Invalid option. Please try again.");
  });

  test("logs session updates and file access stubs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new ExampleClient();

    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    });
    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", url: "https://example.com/image.png" },
      } as unknown as acp.SessionUpdate,
    });
    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read file",
        status: "pending",
      } as unknown as acp.SessionUpdate,
    });
    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      } as unknown as acp.SessionUpdate,
    });
    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
      } as unknown as acp.SessionUpdate,
    });
    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "user" },
      },
    });
    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thought" },
      },
    });
    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "unknown",
      } as unknown as acp.SessionUpdate,
    });

    expect(
      await client.readTextFile({
        path: "/tmp/example.txt",
      }),
    ).toEqual({ content: "Mock file content" });
    expect(
      await client.writeTextFile({
        path: "/tmp/example.txt",
        content: "updated",
      }),
    ).toEqual({});
    expect(log).toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe("example agent", () => {
  test("handles session lifecycle, permission outcomes, and prompt cancellation", async () => {
    const sessionUpdates: acp.SessionNotification[] = [];
    const requestPermission = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: { outcome: "selected", optionId: "allow" },
      })
      .mockResolvedValueOnce({
        outcome: { outcome: "selected", optionId: "reject" },
      })
      .mockResolvedValueOnce({
        outcome: { outcome: "cancelled" },
      })
      .mockResolvedValueOnce({
        outcome: { outcome: "selected", optionId: "unexpected" },
      });
    const connection = {
      sessionUpdate: vi.fn(async (params: acp.SessionNotification) => {
        sessionUpdates.push(params);
      }),
      requestPermission,
    };
    const agent = new ExampleAgent(connection as unknown as acp.AgentSideConnection);
    const noDelay = vi.fn(async () => {});
    const noModelDelay = vi.fn(async () => {});

    Reflect.set(agent, "delayBetweenStreamChunks", noDelay);
    Reflect.set(agent, "simulateModelInteraction", noModelDelay);

    expect(
      await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }),
    ).toMatchObject({
      protocolVersion: acp.PROTOCOL_VERSION,
    });
    expect(await agent.authenticate({ tokens: {} })).toEqual({});
    expect(await agent.setSessionMode({ sessionId: "session-1", mode: "default" })).toEqual({});
    await expect(
      agent.prompt({ sessionId: "missing", prompt: [{ type: "text", text: "hello" }] }),
    ).rejects.toThrow("Session missing not found");

    const created = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const allowResult = await agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    const rejectResult = await agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    const cancelledResult = await agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });

    await expect(
      agent.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      }),
    ).rejects.toThrow("Unexpected permission outcome");

    const cancellingAgent = new ExampleAgent(connection as unknown as acp.AgentSideConnection);
    Reflect.set(
      cancellingAgent,
      "simulateTurn",
      (_sessionId: string, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    const cancellingSession = await cancellingAgent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    const cancelledPrompt = cancellingAgent.prompt({
      sessionId: cancellingSession.sessionId,
      prompt: [{ type: "text", text: "cancel" }],
    });
    await cancellingAgent.cancel({
      id: "cancel-1",
      sessionId: cancellingSession.sessionId,
    } as unknown as acp.CancelNotification);

    expect(allowResult).toEqual({ stopReason: "end_turn" });
    expect(rejectResult).toEqual({ stopReason: "end_turn" });
    expect(cancelledResult).toEqual({ stopReason: "end_turn" });
    expect(await cancelledPrompt).toEqual({ stopReason: "cancelled" });
    expect(noDelay).toHaveBeenCalled();
    expect(noModelDelay).toHaveBeenCalled();
    expect(sessionUpdates.some((update) => update.update.sessionUpdate === "tool_call")).toBe(true);
  });

  test("covers private chunking helpers and uint8 stream conversion", async () => {
    vi.useFakeTimers();

    const connection = {
      sessionUpdate: vi.fn(async () => {}),
      requestPermission: vi.fn(),
    };
    const agent = new ExampleAgent(connection as unknown as acp.AgentSideConnection);
    const streamChunks = getPrivateMethod<[string, string, AbortSignal], Promise<void>>(
      agent,
      "streamAgentMessageChunks",
    );
    const delayBetweenChunks = getPrivateMethod<[AbortSignal], Promise<void>>(
      agent,
      "delayBetweenStreamChunks",
    );
    const simulateModelInteraction = getPrivateMethod<[AbortSignal], Promise<void>>(
      agent,
      "simulateModelInteraction",
    );

    await streamChunks("session-1", "    ", new AbortController().signal);
    await streamChunks("session-1", "", new AbortController().signal);

    const aborted = new AbortController();
    aborted.abort();
    await expect(streamChunks("session-1", "hello", aborted.signal)).rejects.toThrow("aborted");
    await expect(delayBetweenChunks(aborted.signal)).rejects.toThrow("aborted");

    const active = new AbortController();
    const delayPromise = delayBetweenChunks(active.signal);
    await vi.advanceTimersByTimeAsync(100);
    await delayPromise;

    const abortDuringDelay = new AbortController();
    const rejectedDelay = delayBetweenChunks(abortDuringDelay.signal);
    abortDuringDelay.abort();
    await expect(rejectedDelay).rejects.toThrow("aborted");

    const abortInsideTimer = new AbortController();
    const removeEventListener = abortInsideTimer.signal.removeEventListener.bind(
      abortInsideTimer.signal,
    );
    Object.defineProperty(abortInsideTimer.signal, "removeEventListener", {
      configurable: true,
      value: (...args: Parameters<AbortSignal["removeEventListener"]>) => {
        removeEventListener(...args);
        abortInsideTimer.abort();
      },
    });
    const rejectedInsideTimer = delayBetweenChunks(abortInsideTimer.signal);
    const rejectedInsideTimerExpectation = expect(rejectedInsideTimer).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(100);
    await rejectedInsideTimerExpectation;

    const interactionPromise = simulateModelInteraction(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    await interactionPromise;

    const abortedInteraction = new AbortController();
    abortedInteraction.abort();
    const rejectedInteraction = simulateModelInteraction(abortedInteraction.signal);
    const rejectedInteractionExpectation = expect(rejectedInteraction).rejects.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    await rejectedInteractionExpectation;

    const reader = toUint8ReadableStream(
      Readable.toWeb(Readable.from([Buffer.from([1, 2, 3])])),
    ).getReader();
    const firstRead = await reader.read();
    expect(firstRead.done).toBe(false);
    expect(Array.from(firstRead.value ?? [])).toEqual([1, 2, 3]);
    expect(await reader.read()).toEqual({
      done: true,
      value: undefined,
    });
  });
});

describe("bootstrap entrypoints", () => {
  test("wires ACP over stdio, tcp, and server bootstrap helpers", async () => {
    let capturedInput: WritableStream<Uint8Array> | undefined;
    let capturedOutput: ReadableStream<Uint8Array> | undefined;
    const ndJsonStream = vi.fn(
      (input: WritableStream<Uint8Array>, output: ReadableStream<Uint8Array>) => {
        capturedInput = input;
        capturedOutput = output;
        return { kind: "stream" };
      },
    );
    const AgentSideConnection = vi.fn(function (
      this: unknown,
      factory: (conn: acp.AgentSideConnection) => ExampleAgent,
    ) {
      return factory({
        sessionUpdate: vi.fn(async () => {}),
        requestPermission: vi.fn(async () => ({ outcome: { outcome: "cancelled" } })),
      } as unknown as acp.AgentSideConnection);
    });
    const createServer = vi.fn((handler: (socket: FakeSocket) => void) => {
      const socket = new FakeSocket();
      return {
        listen(port: number, onListen?: () => void) {
          onListen?.();
          handler(socket);
          return { close: vi.fn() };
        },
      };
    });

    vi.doMock("@agentclientprotocol/sdk", async () => {
      const actual = await vi.importActual<typeof import("@agentclientprotocol/sdk")>(
        "@agentclientprotocol/sdk",
      );
      return {
        ...actual,
        ndJsonStream,
        AgentSideConnection,
      };
    });
    vi.doMock("node:net", async () => {
      const actual = await vi.importActual<typeof import("node:net")>("node:net");
      return {
        ...actual,
        createServer,
      };
    });

    const agentModule = await import("../src/flamecast/agent.js?bootstrap");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    agentModule.connectStdio();
    await agentModule.listenTcp(4000);
    const writer = capturedInput?.getWriter();
    const reader = capturedOutput?.getReader();
    if (!writer || !reader) {
      throw new Error("Expected tcp stream handles");
    }
    await writer.write(new Uint8Array([1]));
    const firstRead = await reader.read();
    expect(firstRead.done).toBe(false);
    await writer.close();
    await reader.cancel();
    process.env.ACP_PORT = "4000";
    agentModule.main();
    delete process.env.ACP_PORT;
    agentModule.main();

    expect(ndJsonStream).toHaveBeenCalled();
    expect(AgentSideConnection).toHaveBeenCalled();
    expect(createServer).toHaveBeenCalledTimes(2);
    expect(stderr).toHaveBeenCalledWith("Agent listening on port 4000");
  });

  test("propagates tcp socket write failures", async () => {
    let capturedInput: WritableStream<Uint8Array> | undefined;
    const failingSocket = new FakeSocket();
    failingSocket.write.mockImplementation((_chunk, callback) => {
      callback?.(new Error("socket write failed"));
      return false;
    });
    const ndJsonStream = vi.fn((input: WritableStream<Uint8Array>) => {
      capturedInput = input;
      return { kind: "stream" };
    });
    const createServer = vi.fn((handler: (socket: FakeSocket) => void) => ({
      listen(_port: number, onListen?: () => void) {
        onListen?.();
        handler(failingSocket);
      },
    }));

    vi.doMock("@agentclientprotocol/sdk", async () => {
      const actual = await vi.importActual<typeof import("@agentclientprotocol/sdk")>(
        "@agentclientprotocol/sdk",
      );
      return {
        ...actual,
        ndJsonStream,
        AgentSideConnection: vi.fn(),
      };
    });
    vi.doMock("node:net", async () => {
      const actual = await vi.importActual<typeof import("node:net")>("node:net");
      return {
        ...actual,
        createServer,
      };
    });

    const agentModule = await import("../src/flamecast/agent.js?tcp-write-error");
    await agentModule.listenTcp(4010);
    const writer = capturedInput?.getWriter();
    if (!writer) {
      throw new Error("Expected tcp input writer");
    }

    await expect(writer.write(new Uint8Array([1]))).rejects.toThrow("socket write failed");
    writer.releaseLock();
  });

  test("propagates tcp socket output errors", async () => {
    let capturedOutput: ReadableStream<Uint8Array> | undefined;
    const sockets: FakeSocket[] = [];
    const ndJsonStream = vi.fn(
      (_input: WritableStream<Uint8Array>, output: ReadableStream<Uint8Array>) => {
        capturedOutput = output;
        return { kind: "stream" };
      },
    );
    const createServer = vi.fn((handler: (socket: FakeSocket) => void) => ({
      listen(_port: number, onListen?: () => void) {
        const socket = new FakeSocket();
        sockets.push(socket);
        onListen?.();
        handler(socket);
      },
    }));

    vi.doMock("@agentclientprotocol/sdk", async () => {
      const actual = await vi.importActual<typeof import("@agentclientprotocol/sdk")>(
        "@agentclientprotocol/sdk",
      );
      return {
        ...actual,
        ndJsonStream,
        AgentSideConnection: vi.fn(function (
          this: unknown,
          factory: (conn: acp.AgentSideConnection) => ExampleAgent,
        ) {
          return factory({
            sessionUpdate: vi.fn(async () => {}),
            requestPermission: vi.fn(async () => ({ outcome: { outcome: "cancelled" } })),
          } as unknown as acp.AgentSideConnection);
        }),
      };
    });
    vi.doMock("node:net", async () => {
      const actual = await vi.importActual<typeof import("node:net")>("node:net");
      return {
        ...actual,
        createServer,
      };
    });

    const agentModule = await import("../src/flamecast/agent.js?tcp-output-error");
    await agentModule.listenTcp(4011);
    const reader = capturedOutput?.getReader();
    if (!reader) {
      throw new Error("Expected tcp output reader");
    }

    const readPromise = reader.read();
    sockets[0]?.emit("error", new Error("socket read failed"));
    await expect(readPromise).rejects.toThrow("socket read failed");
    reader.releaseLock();
  });

  test("does not auto-run the agent or server entrypoints when argv[1] is missing", async () => {
    const ndJsonStream = vi.fn(() => ({ kind: "stream" }));
    const AgentSideConnection = vi.fn();
    const processOn = vi.spyOn(process, "on").mockImplementation(() => process);
    const originalArgv1 = process.argv[1];

    class FlamecastMock {
      readonly listen = vi.fn(async () => ({ close: vi.fn() }));
      readonly shutdown = vi.fn(async () => {});
    }

    vi.doMock("@agentclientprotocol/sdk", async () => {
      const actual = await vi.importActual<typeof import("@agentclientprotocol/sdk")>(
        "@agentclientprotocol/sdk",
      );
      return {
        ...actual,
        ndJsonStream,
        AgentSideConnection,
      };
    });
    vi.doMock(flamecastSourceEntry, () => ({
      Flamecast: FlamecastMock,
    }));

    try {
      vi.resetModules();
      process.argv[1] = undefined as unknown as string;
      await import("../src/flamecast/agent.ts?guard-false");
      await import("../../../apps/server/src/index.ts?guard-false");
    } finally {
      process.argv[1] = originalArgv1;
    }

    expect(AgentSideConnection).not.toHaveBeenCalled();
    expect(processOn).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  test("starts the server module and handles shutdown cleanly", async () => {
    const listen = vi.fn(async () => ({
      close: vi.fn(),
    }));
    const shutdown = vi.fn(async () => {});
    const processOn = vi.spyOn(process, "on").mockImplementation(() => process);
    const processExit = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: string | number | null) => code ?? 0) as typeof process.exit);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    class FlamecastMock {
      readonly listen = listen;
      readonly shutdown = shutdown;
    }

    vi.doMock(flamecastSourceEntry, () => ({
      Flamecast: FlamecastMock,
    }));

    const serverModule = await import("../../../apps/server/src/index.ts?server");
    const started = await serverModule.startServer();
    const mainStarted = await serverModule.main();

    expect(started.flamecast).toBeInstanceOf(FlamecastMock);
    expect(mainStarted.server).toMatchObject({
      close: expect.any(Function),
    });

    const close = vi.fn();
    const stop = serverModule.createShutdownHandler(
      {
        shutdown,
      } as unknown as InstanceType<typeof FlamecastMock>,
      { close },
    );
    await stop();

    expect(listen).toHaveBeenCalledWith(3001);
    expect(processOn).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(processOn).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(close).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("\nShutting down...");
    expect(processExit).toHaveBeenCalledWith(0);
  });

  test("runs server main automatically when imported as the entry module", async () => {
    const serverPath = new URL("../../../apps/server/src/index.ts", import.meta.url);
    const listen = vi.fn(async () => ({ close: vi.fn() }));
    const processOn = vi.spyOn(process, "on").mockImplementation(() => process);
    const originalArgv1 = process.argv[1];

    class FlamecastMock {
      readonly listen = listen;
      readonly shutdown = vi.fn(async () => {});
    }

    vi.doMock(flamecastSourceEntry, () => ({
      Flamecast: FlamecastMock,
    }));

    try {
      vi.resetModules();
      process.argv[1] = fileURLToPath(serverPath);
      await import("../../../apps/server/src/index.ts");
      await Promise.resolve();
    } finally {
      process.argv[1] = originalArgv1;
    }

    expect(listen).toHaveBeenCalledWith(3001);
    expect(processOn).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });
});
