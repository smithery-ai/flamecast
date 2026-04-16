import { afterAll, describe, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { SessionManager } from "../../src/flamecast/sessions/session-manager.js";
import { StreamManager } from "../../src/flamecast/stream-manager.js";

const exec = promisify(execFile);

async function tmuxAvailable(): Promise<boolean> {
  try {
    await exec("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function createSocketPair(): Promise<{
  client: WebSocket;
  server: WebSocket;
  received: string[];
  close: () => Promise<void>;
}> {
  const wss = new WebSocketServer({ port: 0 });
  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  const serverPromise = new Promise<WebSocket>((resolve) => {
    wss.once("connection", resolve);
  });

  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const received: string[] = [];
  client.on("message", (chunk: Buffer | ArrayBuffer | Buffer[]) => {
    if (Array.isArray(chunk)) {
      received.push(Buffer.concat(chunk).toString("utf-8"));
      return;
    }
    if (chunk instanceof ArrayBuffer) {
      received.push(Buffer.from(chunk).toString("utf-8"));
      return;
    }
    received.push(chunk.toString("utf-8"));
  });

  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });

  const server = await serverPromise;

  return {
    client,
    server,
    received,
    close: async () => {
      client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

describe("StreamManager (integration)", async () => {
  const hasTmux = await tmuxAvailable();
  if (!hasTmux) {
    it.skip("tmux is not installed — skipping integration tests", () => {});
    return;
  }

  const sessions = new SessionManager();
  const streams = new StreamManager();

  afterAll(async () => {
    try {
      await exec("tmux", ["kill-server"]);
    } catch {
      // no server running
    }
  });

  it("replays existing pane output to a newly attached client", async () => {
    const created = await sessions.create({ timeout: 0 });

    await sessions.execAsync({
      sessionId: created.sessionId,
      command: "echo before-connect",
    });
    await sleep(250);

    const socketPair = await createSocketPair();
    await streams.addClient(created.sessionId, socketPair.server);

    await waitFor(() => socketPair.received.join("").includes("before-connect"));

    await sessions.close({ sessionId: created.sessionId });
    streams.disconnectAll(created.sessionId);
    await socketPair.close();
  });

  it("streams interactive websocket input back to connected clients", async () => {
    const created = await sessions.create({ timeout: 0 });
    const socketPair = await createSocketPair();
    await streams.addClient(created.sessionId, socketPair.server);

    await streams.handleMessage(created.sessionId, "echo ws-input");
    await streams.handleMessage(created.sessionId, "\r");

    await waitFor(() => socketPair.received.join("").includes("ws-input"));

    await sessions.close({ sessionId: created.sessionId });
    streams.disconnectAll(created.sessionId);
    await socketPair.close();
  });
});
