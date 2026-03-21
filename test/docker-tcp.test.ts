import { describe, it, expect } from "vitest";
import Docker from "dockerode";
import { createConnection, createServer } from "node:net";

const docker = new Docker();

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForPort(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      if (Date.now() > deadline) {
        reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
        return;
      }
      const socket = createConnection({ host, port }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => setTimeout(attempt, 500));
    }
    attempt();
  });
}

describe("docker TCP transport", () => {
  it("sends ACP initialize and gets a response via raw socket", async () => {
    const port = await findFreePort();

    const container = await docker.createContainer({
      Image: "flamecast/example-agent:latest",
      Env: [`ACP_PORT=${port}`],
      ExposedPorts: { [`${port}/tcp`]: {} },
      HostConfig: {
        PortBindings: { [`${port}/tcp`]: [{ HostPort: String(port) }] },
      },
    });
    await container.start();

    try {
      await waitForPort("localhost", port);
      await new Promise((r) => setTimeout(r, 1000));
      await new Promise((r) => setTimeout(r, 1000)); // Let agent fully init

      // Raw socket test
      const response = await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: "localhost", port }, () => {
          socket.setNoDelay(true);
          socket.on("data", (chunk) => {
            resolve(chunk.toString());
            socket.destroy();
          });
          const msg = JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: 1, clientCapabilities: {} },
          }) + "\n";
          socket.write(msg);
        });
        socket.on("error", reject);
        setTimeout(() => reject(new Error("timeout")), 10_000);
      });

      const parsed = JSON.parse(response);
      expect(parsed.result.protocolVersion).toBe(1);
    } finally {
      await container.stop().catch(() => {});
      await container.remove().catch(() => {});
    }
  });

  it("sends ACP initialize via WritableStream/ReadableStream wrappers", async () => {
    const port = await findFreePort();

    const container = await docker.createContainer({
      Image: "flamecast/example-agent:latest",
      Env: [`ACP_PORT=${port}`],
      ExposedPorts: { [`${port}/tcp`]: {} },
      HostConfig: {
        PortBindings: { [`${port}/tcp`]: [{ HostPort: String(port) }] },
      },
    });
    await container.start();

    try {
      await waitForPort("localhost", port);
      await new Promise((r) => setTimeout(r, 1000));

      const response = await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: "localhost", port }, async () => {
          socket.setNoDelay(true);

          const input = new WritableStream<Uint8Array>({
            write(chunk) {
              return new Promise<void>((res, rej) => {
                socket.write(chunk, (err) => (err ? rej(err) : res()));
              });
            },
          });

          const output = new ReadableStream<Uint8Array>({
            start(controller) {
              socket.on("data", (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
              });
              socket.on("end", () => controller.close());
            },
          });

          // Write via WritableStream
          const writer = input.getWriter();
          const msg = JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: 1, clientCapabilities: {} },
          }) + "\n";
          await writer.write(new TextEncoder().encode(msg));
          writer.releaseLock();

          // Read via ReadableStream
          const reader = output.getReader();
          const { value } = await reader.read();
          resolve(new TextDecoder().decode(value));
          reader.releaseLock();
          socket.destroy();
        });
        socket.on("error", reject);
        setTimeout(() => reject(new Error("timeout")), 10_000);
      });

      const parsed = JSON.parse(response);
      expect(parsed.result.protocolVersion).toBe(1);
    } finally {
      await container.stop().catch(() => {});
      await container.remove().catch(() => {});
    }
  });

  it("sends ACP initialize via ndJsonStream (full SDK path)", async () => {
    const port = await findFreePort();
    const acp = await import("@agentclientprotocol/sdk");

    const container = await docker.createContainer({
      Image: "flamecast/example-agent:latest",
      Env: [`ACP_PORT=${port}`],
      ExposedPorts: { [`${port}/tcp`]: {} },
      HostConfig: {
        PortBindings: { [`${port}/tcp`]: [{ HostPort: String(port) }] },
      },
    });
    await container.start();

    try {
      await waitForPort("localhost", port);
      await new Promise((r) => setTimeout(r, 1000));

      const { input, output } = await new Promise<{
        input: WritableStream<Uint8Array>;
        output: ReadableStream<Uint8Array>;
      }>((resolve, reject) => {
        const socket = createConnection({ host: "localhost", port }, () => {
          socket.setNoDelay(true);
          const input = new WritableStream<Uint8Array>({
            write(chunk) {
              return new Promise<void>((res, rej) => {
                socket.write(chunk, (err) => (err ? rej(err) : res()));
              });
            },
            close() { socket.end(); },
          });
          const output = new ReadableStream<Uint8Array>({
            start(controller) {
              socket.on("data", (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
              });
              socket.on("end", () => controller.close());
            },
            cancel() { socket.destroy(); },
          });
          resolve({ input, output });
        });
        socket.on("error", reject);
      });

      const stream = acp.ndJsonStream(input, output);
      const connection = new acp.ClientSideConnection(() => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        readTextFile: async () => ({ content: "" }),
        writeTextFile: async () => ({}),
        createTerminal: async () => ({ terminalId: "stub" }),
        terminalOutput: async () => ({ output: "", truncated: false }),
        releaseTerminal: async () => ({}),
        waitForTerminalExit: async () => ({ exitCode: 0 }),
        killTerminal: async () => ({}),
        extMethod: async (method) => { throw acp.RequestError.methodNotFound(method); },
        extNotification: async () => {},
      }), stream);

      const result = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      expect(result.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    } finally {
      await container.stop().catch(() => {});
      await container.remove().catch(() => {});
    }
  }, 60_000);
});
