import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { Flamecast } from "@flamecast/sdk";
import { spawnCloudflared, ensureCloudflared } from "../lib/cloudflared.js";
import type { UpFlags } from "../types.js";

const FLAMECAST_HOME = join(homedir(), ".flamecast");
const LOG_FILE = join(FLAMECAST_HOME, "flamecast.log");
const PID_FILE = join(FLAMECAST_HOME, "daemon.pid");
const DEFAULT_BRIDGE_URL = "https://flamecast-bridge.smithery.workers.dev";

export { LOG_FILE, PID_FILE, isFlamecastProcess };

async function provisionTunnel(
  bridgeUrl: string,
  name: string,
  port: number,
): Promise<{ tunnelToken: string; domain: string }> {
  const response = await fetch(`${bridgeUrl}/api/tunnels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, port }),
  });

  if (!response.ok) {
    const body: { error?: string } = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? `Bridge API error: ${response.status}`);
  }

  const result: { tunnelToken: string; domain: string } = await response.json();
  return result;
}

function isFlamecastProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // The process exists, but verify it's actually a flamecast daemon
  // (PIDs get recycled by the OS, so the PID could belong to an unrelated process)
  try {
    const cmd =
      platform() === "darwin"
        ? `ps -p ${pid} -o command=`
        : `cat /proc/${pid}/cmdline 2>/dev/null || ps -p ${pid} -o args=`;
    const output = execSync(cmd, { timeout: 2000 }).toString();
    return output.includes("flamecast");
  } catch {
    // If we can't inspect the process, assume it's not ours
    return false;
  }
}

export async function runUp(flags: UpFlags): Promise<number> {
  // If we're the daemon child, run the server directly
  if (process.env.__FLAMECAST_DAEMON === "1") {
    return runServer(flags);
  }

  return daemonize(flags);
}

async function daemonize(flags: UpFlags): Promise<number> {
  mkdirSync(FLAMECAST_HOME, { recursive: true });

  // Check if already running
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (isFlamecastProcess(pid)) {
      console.log(`Flamecast is already running (PID ${pid})`);
      console.log(`Logs: ${LOG_FILE}`);
      return 1;
    }
    // Stale PID file
    unlinkSync(PID_FILE);
  }

  // If --name is set, ensure cloudflared is installed before spawning the daemon
  if (flags.name && !(await ensureCloudflared())) {
    flags = { ...flags, name: undefined };
  }

  // Wipe log file on restart
  const logFd = openSync(LOG_FILE, "w");

  // Reconstruct args for the child
  const childArgs = [process.argv[1], "up"];
  if (flags.name) childArgs.push("--name", flags.name);
  if (flags.port) childArgs.push("--port", String(flags.port));

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd, "ipc"],
    env: { ...process.env, __FLAMECAST_DAEMON: "1" },
    cwd: process.cwd(),
  });

  closeSync(logFd);

  if (!child.pid) {
    console.log("Failed to start daemon.");
    return 1;
  }

  type IpcMsg =
    | { type: "ready" }
    | { type: "error"; error: string }
    | { type: "tunnel"; domain?: string; error?: string };

  // Helper: wait for the next IPC message or child exit
  function waitForMessage(
    timeoutMs: number,
  ): Promise<IpcMsg | { type: "exit"; code: number | null } | { type: "timeout" }> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve({ type: "timeout" });
      }, timeoutMs);

      function onMessage(msg: IpcMsg) {
        cleanup();
        resolve(msg);
      }
      function onExit(code: number | null) {
        cleanup();
        resolve({ type: "exit", code });
      }
      function cleanup() {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
      }

      child.on("message", onMessage);
      child.on("exit", onExit);
    });
  }

  // Phase 1: wait for server to be ready
  const first = await waitForMessage(30_000);

  if (first.type === "error") {
    child.disconnect();
    child.unref();
    console.error(`Failed to start Flamecast: ${first.error}`);
    return 1;
  }
  if (first.type === "exit") {
    console.error(
      `Failed to start Flamecast: process exited with code ${first.code}. Check logs: ${LOG_FILE}`,
    );
    return 1;
  }
  if (first.type === "timeout") {
    child.disconnect();
    child.unref();
    console.error(`Failed to start Flamecast: timed out waiting for server to start`);
    return 1;
  }

  // Server is up — write PID file so `flamecast down` works
  writeFileSync(PID_FILE, String(child.pid));

  const port = flags.port ?? 3000;
  console.log(`Logs: ${LOG_FILE}`);

  // Phase 2: if --name was given, wait for tunnel result
  let tunnelDomain: string | undefined;
  if (flags.name) {
    console.log("Connecting tunnel...");
    const tunnelMsg = await waitForMessage(60_000);
    if (tunnelMsg.type === "tunnel") {
      if (tunnelMsg.error) {
        console.error(`Tunnel failed: ${tunnelMsg.error}`);
        console.log("Running locally only.");
      } else {
        tunnelDomain = tunnelMsg.domain;
      }
    } else {
      console.error("Tunnel timed out.");
      console.log("Running locally only.");
    }
  }

  child.disconnect();
  child.unref();

  console.log(`\nFlamecast started (PID ${child.pid})`);
  console.log(`  Local:  http://localhost:${port}`);
  if (tunnelDomain) {
    console.log(`  Tunnel: https://${tunnelDomain}`);
  }

  return 0;
}

async function runServer(flags: UpFlags): Promise<number> {
  const port = flags.port ?? 3000;

  try {
    const flamecast = new Flamecast();

    // Wrap with CORS
    const wrapper = new Hono();
    wrapper.use("*", cors());
    wrapper.all("*", (c) => flamecast.app.fetch(c.req.raw));

    const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const s = serve({ fetch: wrapper.fetch, port }, () => {
        resolve(s);
      });
      s.on("error", (err: NodeJS.ErrnoException) => {
        reject(err);
      });
    });
    console.log(`Flamecast running on http://localhost:${port}`);

    // Server is listening — tell the parent immediately
    if (process.send) process.send({ type: "ready" });

    // If --name is provided and cloudflared is available, connect tunnel
    let cloudflaredProcess: import("node:child_process").ChildProcess | null = null;
    if (flags.name) {
      if (!(await ensureCloudflared())) {
        if (process.send) process.send({ type: "tunnel", error: "cloudflared not available" });
      } else {
        const bridgeUrl = process.env.FLAMECAST_BRIDGE_URL ?? DEFAULT_BRIDGE_URL;
        try {
          const tunnel = await provisionTunnel(bridgeUrl, flags.name, port);
          cloudflaredProcess = spawnCloudflared(tunnel.tunnelToken);
          console.log(`Live at https://${tunnel.domain}`);
          if (process.send) process.send({ type: "tunnel", domain: tunnel.domain });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.log(`Tunnel unavailable: ${msg}`);
          console.log("Running locally only.");
          if (process.send) process.send({ type: "tunnel", error: msg });
        }
      }
    }

    return await new Promise<number>((resolve) => {
      let shuttingDown = false;

      async function shutdown(): Promise<void> {
        if (shuttingDown) return;
        shuttingDown = true;
        let exitCode = 0;

        console.log("\nShutting down...");
        try {
          if (cloudflaredProcess) {
            try {
              cloudflaredProcess.kill("SIGTERM");
            } catch {
              // already dead
            }
          }
          await new Promise<void>((closeResolve) => {
            server.close(() => {
              closeResolve();
            });
          });
        } catch (error) {
          exitCode = 1;
          console.error(error instanceof Error ? error.message : String(error));
        } finally {
          // Clean up PID file on graceful shutdown
          try {
            unlinkSync(PID_FILE);
          } catch {
            // ignore
          }
          resolve(exitCode);
        }
      }

      process.on("SIGTERM", () => {
        void shutdown();
      });
      process.on("SIGINT", () => {
        void shutdown();
      });
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (process.send) process.send({ type: "error", error: msg });
    throw error;
  }
}
