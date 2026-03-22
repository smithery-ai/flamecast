import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";

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
  vi.restoreAllMocks();
  vi.resetModules();
});

test("covers tcp transport error branches and free-port fallback metadata", async () => {
  const connectedSocket = new FakeSocket();
  connectedSocket.write.mockImplementation((_chunk, callback) => {
    callback?.(new Error("write failed"));
    return false;
  });

  const failingSocket = new FakeSocket();
  const createConnection = vi.fn((_options: unknown, onConnect?: () => void) => {
    if (createConnection.mock.calls.length === 1) {
      queueMicrotask(() => onConnect?.());
      return connectedSocket;
    }

    queueMicrotask(() => {
      failingSocket.emit("error", new Error("connect failed"));
    });
    return failingSocket;
  });
  const createServer = vi.fn(() => ({
    listen: vi.fn((_port: number, onListen?: () => void) => {
      onListen?.();
    }),
    address: vi.fn(() => null),
    close: vi.fn((onClose?: () => void) => {
      onClose?.();
    }),
    on: vi.fn(),
  }));

  vi.doMock("node:net", async () => {
    const actual = await vi.importActual<typeof import("node:net")>("node:net");
    return {
      ...actual,
      createConnection,
      createServer,
    };
  });

  const transport = await import("../src/flamecast/transport.js?error-paths");
  const tcp = await transport.openTcpTransport("127.0.0.1", 1234);
  const writer = tcp.input.getWriter();

  await expect(writer.write(new Uint8Array(Buffer.from("boom")))).rejects.toThrow("write failed");
  writer.releaseLock();
  await tcp.dispose?.();

  await expect(transport.openTcpTransport("127.0.0.1", 5678)).rejects.toThrow("connect failed");
  await expect(transport.findFreePort()).resolves.toBe(0);
});

test("rejects when the free-port probe server emits an error", async () => {
  const server = {
    listen: vi.fn(),
    address: vi.fn(() => null),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (error: Error) => void) => {
      if (event === "error") {
        queueMicrotask(() => handler(new Error("listen failed")));
      }
    }),
  };

  vi.doMock("node:net", async () => {
    const actual = await vi.importActual<typeof import("node:net")>("node:net");
    return {
      ...actual,
      createServer: vi.fn(() => server),
    };
  });

  const transport = await import("../src/flamecast/transport.js?free-port-error");
  await expect(transport.findFreePort()).rejects.toThrow("listen failed");
});

test("propagates tcp output stream errors", async () => {
  const socket = new FakeSocket();
  const createConnection = vi.fn((_options: unknown, onConnect?: () => void) => {
    queueMicrotask(() => onConnect?.());
    return socket;
  });

  vi.doMock("node:net", async () => {
    const actual = await vi.importActual<typeof import("node:net")>("node:net");
    return {
      ...actual,
      createConnection,
    };
  });

  const transport = await import("../src/flamecast/transport.js?output-error");
  const tcp = await transport.openTcpTransport("127.0.0.1", 9999);
  const reader = tcp.output.getReader();
  const readPromise = reader.read();

  socket.emit("error", new Error("socket output failed"));
  await expect(readPromise).rejects.toThrow("socket output failed");
  reader.releaseLock();
  await tcp.dispose?.();
});
