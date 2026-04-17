import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { parseCliArgs } from "../src/cli-app.js";
import { waitForProcessExit } from "../src/commands/down.js";
import { trackServerSockets } from "../src/commands/up.js";

const childProcesses: ChildProcess[] = [];

function getPid(child: ChildProcess): number {
  if (child.pid === undefined) {
    throw new Error("Child process did not start");
  }
  return child.pid;
}

async function spawnReadyProcess(script: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  childProcesses.push(child);

  await new Promise<void>((resolve, reject) => {
    let output = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("ready")) {
        resolve();
      }
    });

    child.once("exit", (code) => {
      reject(new Error(`Child exited before becoming ready (code ${code})`));
    });
    child.once("error", reject);
  });

  return child;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

afterEach(() => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
});

describe("parseCliArgs", () => {
  it("defaults to up with empty flags", () => {
    expect(parseCliArgs([])).toEqual({ kind: "up", flags: {} });
  });

  it("parses the foreground lifecycle commands", () => {
    expect(parseCliArgs(["up", "--name", "demo", "--port", "4312"])).toEqual({
      kind: "up",
      flags: { name: "demo", port: 4312 },
    });
    expect(parseCliArgs(["down"])).toEqual({ kind: "down" });
    expect(parseCliArgs(["status"])).toEqual({ kind: "status" });
  });
});

describe("waitForProcessExit", () => {
  it("waits until a process exits after SIGTERM", async () => {
    const child = await spawnReadyProcess(
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150)); setInterval(() => {}, 1000); process.stdout.write('ready\\n');",
    );
    const pid = getPid(child);
    const startedAt = Date.now();
    process.kill(pid, "SIGTERM");

    const exited = await waitForProcessExit(pid, 2_000, 20);

    expect(exited).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120);
  });

  it("times out when the process does not exit", async () => {
    await expect(waitForProcessExit(process.pid, 150, 20)).resolves.toBe(false);
  });
});

describe("trackServerSockets", () => {
  it("forces upgraded websocket connections closed during shutdown", async () => {
    const server = createServer();
    const destroyTrackedSockets = trackServerSockets(server);
    const wss = new WebSocketServer({ noServer: true });
    let client: WebSocket | null = null;

    server.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(0, () => resolve());
        server.once("error", reject);
      });

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral TCP port");
      }

      const serverConnection = new Promise<WebSocket>((resolve) => {
        wss.once("connection", resolve);
      });

      client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      await new Promise<void>((resolve, reject) => {
        client.once("open", () => resolve());
        client.once("error", reject);
      });
      await serverConnection;

      let closed = false;
      const closePromise = new Promise<void>((resolve) => {
        server.close(() => {
          closed = true;
          resolve();
        });
      });

      await sleep(100);
      expect(closed).toBe(false);

      const clientClosed = new Promise<void>((resolve) => {
        client.once("close", () => resolve());
      });

      destroyTrackedSockets();

      await Promise.race([
        closePromise,
        sleep(1_000).then(() => {
          throw new Error("Expected server.close() to finish after destroying tracked sockets");
        }),
      ]);
      await clientClosed;
    } finally {
      client?.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }
  });
});
