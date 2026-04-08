import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { homedir, platform, arch } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import {
  assertDatabaseReady,
  createDatabase,
  createStorageFromDb,
  defaultAgentTemplates,
} from "@flamecast/storage-psql";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { spawnCloudflared, ensureCloudflared } from "../lib/cloudflared.js";
import type { UpFlags } from "../types.js";

const FLAMECAST_HOME = join(homedir(), ".flamecast");
const SESSION_HOST_BIN_DIR = join(FLAMECAST_HOME, "bin");
const LOG_FILE = join(FLAMECAST_HOME, "flamecast.log");
const PID_FILE = join(FLAMECAST_HOME, "daemon.pid");
const DEFAULT_BRIDGE_URL = "https://flamecast-bridge.smithery.workers.dev";

export { LOG_FILE, PID_FILE };

function resolveStorageFlags(flags: UpFlags): { url?: string; dataDir?: string } {
  const url = flags.url ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  const dataDir = flags.dataDir;

  if (url && dataDir) {
    throw new Error('Pass either "--url" or "--data-dir", not both.');
  }

  return {
    ...(url ? { url } : {}),
    ...(dataDir ? { dataDir } : {}),
  };
}

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

function resolveNativeBinary(): string | null {
  if (process.env.SESSION_HOST_BINARY) {
    const p = process.env.SESSION_HOST_BINARY;
    if (!existsSync(p)) {
      throw new Error(`SESSION_HOST_BINARY points to "${p}" which does not exist`);
    }
    return p;
  }
  const binaryPath = join(SESSION_HOST_BIN_DIR, "session-host-native");
  if (existsSync(binaryPath)) return binaryPath;
  return null;
}

async function ensureSessionHost(): Promise<void> {
  if (resolveNativeBinary()) return;

  const os = platform();
  const cpu = arch();

  let binaryName: string;
  if (os === "darwin" && cpu === "arm64") binaryName = "session-host-darwin-arm64";
  else if (os === "darwin" && cpu === "x64") binaryName = "session-host-darwin-amd64";
  else if (os === "linux" && cpu === "x64") binaryName = "session-host-amd64";
  else if (os === "linux" && cpu === "arm64") binaryName = "session-host-arm64";
  else throw new Error(`Unsupported platform: ${os}/${cpu}`);

  const url = `https://github.com/smithery-ai/flamecast/releases/download/session-host-latest/${binaryName}`;
  console.log(`Downloading session-host for ${os}/${cpu}...`);

  mkdirSync(SESSION_HOST_BIN_DIR, { recursive: true });

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download session-host: ${response.status} from ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const outputPath = join(SESSION_HOST_BIN_DIR, "session-host-native");
  writeFileSync(outputPath, buffer);
  chmodSync(outputPath, 0o755);
  console.log("Downloaded session-host binary.");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
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

function daemonize(flags: UpFlags): number {
  mkdirSync(FLAMECAST_HOME, { recursive: true });

  // Check if already running
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (isProcessRunning(pid)) {
      console.log(`Flamecast is already running (PID ${pid})`);
      console.log(`Logs: ${LOG_FILE}`);
      return 1;
    }
    // Stale PID file
    unlinkSync(PID_FILE);
  }

  // Wipe log file on restart
  const logFd = openSync(LOG_FILE, "w");

  // Reconstruct args for the child
  const childArgs = [process.argv[1], "up"];
  if (flags.name) childArgs.push("--name", flags.name);
  if (flags.url) childArgs.push("--url", flags.url);
  if (flags.dataDir) childArgs.push("--data-dir", flags.dataDir);
  if (flags.port) childArgs.push("--port", String(flags.port));

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, __FLAMECAST_DAEMON: "1" },
    cwd: process.cwd(),
  });

  child.unref();
  closeSync(logFd);

  if (!child.pid) {
    console.log("Failed to start daemon.");
    return 1;
  }

  writeFileSync(PID_FILE, String(child.pid));

  const port = flags.port ?? 3001;
  console.log(`Flamecast started (PID ${child.pid})`);
  console.log(`  Local:  http://localhost:${port}`);
  if (flags.name) {
    console.log(`  Tunnel: https://${flags.name}.flamecast.app (connecting...)`);
  }
  console.log(`  Logs:   ${LOG_FILE}`);

  return 0;
}

async function runServer(flags: UpFlags): Promise<number> {
  const port = flags.port ?? 3001;

  try {
    await ensureSessionHost();
  } catch (error) {
    console.error(
      `Failed to ensure session-host: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`View logs: ${LOG_FILE}`);
    return 1;
  }

  const storageOptions = resolveStorageFlags(flags);
  const bundle = await createDatabase(storageOptions);

  try {
    await assertDatabaseReady(bundle);

    const storage = createStorageFromDb(bundle.db);
    if (storageOptions.url === undefined) {
      await storage.seedAgentTemplates(defaultAgentTemplates);
    }

    const runtime = new NodeRuntime();
    const flamecast = new Flamecast({
      storage,
      runtimes: { default: runtime },
    });

    // Wrap with CORS and root redirect
    const wrapper = new Hono();
    wrapper.use("*", cors());
    wrapper.get("/", (c: { req: { raw: Request }; redirect: (url: string) => Response }) => {
      const reqUrl = new URL(c.req.raw.url);
      const proto = c.req.raw.headers.get("x-forwarded-proto") ?? reqUrl.protocol.replace(":", "");
      const backendUrl = `${proto}://${reqUrl.host}/api`;
      return c.redirect(`https://flamecast.dev?backendUrl=${encodeURIComponent(backendUrl)}`);
    });
    wrapper.all("*", (c: { req: { raw: Request } }) => flamecast.app.fetch(c.req.raw));

    const server = serve({ fetch: wrapper.fetch, port }, () => {
      console.log(`Flamecast running on http://localhost:${port}`);
      console.log(`API: http://localhost:${port}/api`);
    });

    // Proxy WebSocket upgrades to the session-host so they work through the tunnel.
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const wsUrl = runtime.getWebsocketUrl();
      if (!wsUrl) {
        socket.destroy();
        return;
      }

      const target = new URL(wsUrl);
      const upstream = createConnection(
        { host: target.hostname, port: Number(target.port) },
        () => {
          const path = req.url ?? "/";
          const headers = [`GET ${path} HTTP/1.1`];
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const key = req.rawHeaders[i];
            if (key.toLowerCase() === "host") {
              headers.push(`Host: ${target.host}`);
            } else {
              headers.push(`${key}: ${req.rawHeaders[i + 1]}`);
            }
          }
          upstream.write(headers.join("\r\n") + "\r\n\r\n");
          if (head.length > 0) upstream.write(head);

          upstream.pipe(socket);
          socket.pipe(upstream);
        },
      );

      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });

    // If --name is provided and cloudflared is available, connect tunnel
    let cloudflaredProcess: import("node:child_process").ChildProcess | null = null;
    if (flags.name) {
      if (!(await ensureCloudflared())) {
        console.log("Running locally only.");
      } else {
        const bridgeUrl = process.env.FLAMECAST_BRIDGE_URL ?? DEFAULT_BRIDGE_URL;
        try {
          const tunnel = await provisionTunnel(bridgeUrl, flags.name, port);
          cloudflaredProcess = spawnCloudflared(tunnel.tunnelToken);
          console.log(`Live at https://${tunnel.domain}`);
        } catch (error) {
          console.log(
            `Tunnel unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
          console.log("Running locally only.");
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
          await flamecast.shutdown();
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
          await bundle.close().catch(() => {});
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
    await bundle.close().catch(() => {});
    throw error;
  }
}
