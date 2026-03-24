#!/usr/bin/env node
/**
 * Session router — routes /sessions/:sessionId/* to per-session bridge processes.
 *
 * Spawns a new runtime-bridge child process per session on /start.
 * Managed by scope.spawn in the FlamecastRuntime Alchemy resource.
 *
 * Env vars:
 *   ROUTER_PORT — port to listen on (default: 0 = random)
 *   BRIDGE_ENTRY — path to the runtime-bridge entrypoint (dist/index.js)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";

const ROUTER_PORT = parseInt(process.env.ROUTER_PORT ?? "0", 10);
const BRIDGE_ENTRY = process.env.BRIDGE_ENTRY ?? "";

if (!BRIDGE_ENTRY) {
  console.error("BRIDGE_ENTRY is required");
  process.exit(1);
}

// ---- Per-session bridge tracking ----

const bridges = new Map<string, { port: number; process: ChildProcess }>();

function waitForBridgePort(proc: ChildProcess, timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(
      () => reject(new Error(`Bridge did not start within ${timeoutMs}ms`)),
      timeoutMs,
    );

    const check = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/listening on port (\d+)/);
      if (match) {
        clearTimeout(timeout);
        proc.stdout?.removeAllListeners("data");
        proc.stderr?.removeAllListeners("data");
        resolve(parseInt(match[1], 10));
      }
    };

    proc.stdout?.on("data", check);
    proc.stderr?.on("data", check);
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
    proc.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`Bridge exited with code ${code}`)); });
  });
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ---- HTTP server ----

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const match = url.pathname.match(/^\/sessions\/([^/]+)(\/.*)?$/);

    if (!match) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const sessionId = match[1];
    const subPath = match[2] ?? "/";

    // Spawn bridge on /start
    if (subPath === "/start" && req.method === "POST") {
      if (bridges.has(sessionId)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session already exists" }));
        return;
      }

      const proc = spawn(process.execPath, [BRIDGE_ENTRY], {
        env: { ...process.env, BRIDGE_PORT: "0" },
        stdio: ["pipe", "pipe", "inherit"],
      });

      const bridgePort = await waitForBridgePort(proc);
      bridges.set(sessionId, { port: bridgePort, process: proc });
      proc.on("exit", () => bridges.delete(sessionId));

      const body = await readBody(req);
      const response = await fetch(`http://localhost:${bridgePort}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(await response.text());
      return;
    }

    const bridge = bridges.get(sessionId);
    if (!bridge) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Session ${sessionId} not found` }));
      return;
    }

    // Forward to bridge, clean up on terminate
    const body = req.method !== "GET" ? await readBody(req) : undefined;
    const response = await fetch(`http://localhost:${bridge.port}${subPath}`, {
      method: req.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (subPath === "/terminate" && req.method === "POST") {
      bridge.process.kill();
      bridges.delete(sessionId);
    }

    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(await response.text());
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }));
  }
});

// ---- Start ----

server.listen(ROUTER_PORT, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : ROUTER_PORT;
  console.log(`[session-router] listening on port ${port}`);
});

// Clean up all bridges on exit
process.on("SIGINT", () => {
  for (const [, bridge] of bridges) bridge.process.kill();
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  for (const [, bridge] of bridges) bridge.process.kill();
  server.close();
  process.exit(0);
});
