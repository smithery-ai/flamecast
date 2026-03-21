import { afterEach, describe, expect, test, vi } from "vitest";

describe("AgentAcpClient", () => {
  afterEach(() => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, "window");
  });

  test("waits for in-flight initialize before closing the transport", async () => {
    const order: string[] = [];
    let resolveInitialize!: () => void;
    const initializePromise = new Promise<void>((resolve) => {
      resolveInitialize = resolve;
    });

    vi.doMock("@agentclientprotocol/sdk", () => {
      class ClientSideConnection {
        constructor(
          _factory: unknown,
          _stream: { readable: ReadableStream<unknown>; writable: WritableStream<unknown> },
        ) {}

        async initialize() {
          order.push("initialize:start");
          await initializePromise;
          order.push("initialize:end");
        }
      }

      return {
        PROTOCOL_VERSION: "test",
        ClientSideConnection,
        RequestError: {
          methodNotFound(method: string) {
            return new Error(`method not found: ${method}`);
          },
        },
        CLIENT_METHODS: {
          fs_read_text_file: "fs/read_text_file",
          fs_write_text_file: "fs/write_text_file",
          terminal_create: "terminal/create",
        },
      };
    });

    vi.doMock("@/shared/acp-streamable-http-client", () => {
      class AcpStreamableHttpClientTransport {
        readonly stream = {
          readable: new ReadableStream(),
          writable: new WritableStream(),
        };

        async start() {
          order.push("transport:start");
        }

        async close() {
          order.push("transport:close");
        }
      }

      return { AcpStreamableHttpClientTransport };
    });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://localhost:3000" },
      },
      writable: true,
    });

    const { AgentAcpClient } = await import("../src/client/lib/agent-acp");
    const client = new AgentAcpClient("agent-1");

    const connectPromise = client.connect();
    await Promise.resolve();
    await Promise.resolve();

    const closePromise = client.close();

    expect(order).toEqual(["transport:start", "initialize:start"]);

    resolveInitialize();
    await connectPromise.catch(() => undefined);
    await closePromise;

    expect(order).toEqual([
      "transport:start",
      "initialize:start",
      "initialize:end",
      "transport:close",
    ]);
  });

  test("cancels pending permission requests when closing", async () => {
    vi.doMock("@agentclientprotocol/sdk", () => {
      class ClientSideConnection {
        constructor(
          _factory: unknown,
          _stream: { readable: ReadableStream<unknown>; writable: WritableStream<unknown> },
        ) {}

        async initialize() {}
      }

      return {
        PROTOCOL_VERSION: "test",
        ClientSideConnection,
        RequestError: {
          methodNotFound(method: string) {
            return new Error(`method not found: ${method}`);
          },
        },
        CLIENT_METHODS: {
          fs_read_text_file: "fs/read_text_file",
          fs_write_text_file: "fs/write_text_file",
          terminal_create: "terminal/create",
        },
      };
    });

    vi.doMock("@/shared/acp-streamable-http-client", () => {
      class AcpStreamableHttpClientTransport {
        readonly stream = {
          readable: new ReadableStream(),
          writable: new WritableStream(),
        };

        async start() {}
        async close() {}
      }

      return { AcpStreamableHttpClientTransport };
    });

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://localhost:3000" },
      },
      writable: true,
    });

    const { AgentAcpClient } = await import("../src/client/lib/agent-acp");
    const client = new AgentAcpClient("agent-1");
    const createClientHandler = Reflect.get(client, "createClientHandler");
    if (typeof createClientHandler !== "function") {
      throw new Error("Expected createClientHandler to exist");
    }

    const handler = createClientHandler.call(client);
    if (
      typeof handler !== "object" ||
      handler === null ||
      !("requestPermission" in handler) ||
      typeof handler.requestPermission !== "function"
    ) {
      throw new Error("Expected requestPermission handler");
    }

    const responsePromise = handler.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "call-1",
        title: "Need permission",
        kind: "edit",
        status: "pending",
        rawInput: {},
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });

    await client.close();

    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
});
