import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";

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
      // oxlint-disable-next-line no-type-assertion/no-type-assertion
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
