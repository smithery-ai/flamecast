#!/usr/bin/env node
/**
 * Session router — routes /sessions/:sessionId/* to per-session session-host processes.
 *
 * Spawns a new session-host child process per session on /start.
 * Each session-host gets a random port and handles exactly one session.
 *
 * Env vars:
 *   ROUTER_PORT — port to listen on (default: 8787)
 *   SESSION_HOST_ENTRY — path to session-host entrypoint (default: dist/index.js relative to this file)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBody } from "./http-utils.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const ROUTER_PORT = parseInt(process.env.ROUTER_PORT ?? "8787", 10);
const SESSION_HOST_ENTRY = process.env.SESSION_HOST_ENTRY ?? resolve(thisDir, "../dist/index.js");

// ---- Per-session tracking ----

const sessions = new Map<string, { port: number; process: ChildProcess }>();

function waitForPort(proc: ChildProcess, timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(
      () => reject(new Error(`Session host did not start within ${timeoutMs}ms`)),
      timeoutMs,
    );

    const check = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/listening on port (\d+)/);
      if (match) {
        clearTimeout(timeout);
        proc.stdout?.removeAllListeners("data");
        proc.stderr?.removeAllListeners("data");
        // Pipe remaining output to parent so child logs aren't lost
        proc.stdout?.pipe(process.stdout);
        proc.stderr?.pipe(process.stderr);
        resolve(parseInt(match[1], 10));
      }
    };

    proc.stdout?.on("data", check);
    proc.stderr?.on("data", check);
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Session host exited with code ${code}`));
    });
  });
}

// ---- HTTP server ----

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/sessions\/([^/]+)(\/.*)?$/);

    if (!match) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const sessionId = match[1];
    const subPath = match[2] ?? "/";

    // Spawn a new session-host on /start
    if (subPath === "/start" && req.method === "POST") {
      if (sessions.has(sessionId)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session already exists" }));
        return;
      }

      const nodeBinDir = dirname(process.execPath);
      // If entry is a .ts file (dev mode), use tsx to run it
      const isTsEntry = SESSION_HOST_ENTRY.endsWith(".ts");
      const spawnCmd = isTsEntry ? "tsx" : process.execPath;
      const spawnArgs = [SESSION_HOST_ENTRY];
      const proc = spawn(spawnCmd, spawnArgs, {
        env: {
          ...process.env,
          SESSION_HOST_PORT: "0", // random port
          PATH: `${nodeBinDir}:${process.env.PATH ?? ""}`,
        },
        stdio: ["pipe", "pipe", "inherit"],
      });

      const hostPort = await waitForPort(proc);
      sessions.set(sessionId, { port: hostPort, process: proc });
      proc.on("exit", () => sessions.delete(sessionId));

      const body = await readBody(req);
      const response = await fetch(`http://localhost:${hostPort}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      // Rewrite hostUrl/websocketUrl to use the session-host's actual port
      const result = await response.json();
      result.hostUrl = `http://localhost:${hostPort}`;
      result.websocketUrl = `ws://localhost:${hostPort}`;

      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Session ${sessionId} not found` }));
      return;
    }

    // Forward to the session's host process
    const body = req.method !== "GET" ? await readBody(req) : undefined;
    const response = await fetch(`http://localhost:${session.port}${subPath}`, {
      method: req.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (subPath === "/terminate" && req.method === "POST") {
      session.process.kill();
      sessions.delete(sessionId);
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

process.on("SIGINT", () => {
  for (const [, s] of sessions) s.process.kill();
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  for (const [, s] of sessions) s.process.kill();
  server.close();
  process.exit(0);
});
