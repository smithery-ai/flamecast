import { execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { Flamecast } from "@flamecast/sdk";
import { spawnCloudflared, ensureCloudflared } from "../lib/cloudflared.js";
import type { UpFlags } from "../types.js";

const FLAMECAST_HOME = join(homedir(), ".flamecast");
const PID_FILE = join(FLAMECAST_HOME, "daemon.pid");
const DEFAULT_BRIDGE_URL = "https://flamecast-bridge.smithery.workers.dev";

export { PID_FILE, isFlamecastProcess };

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

  // The process exists, but verify it's actually a Flamecast process
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
  mkdirSync(FLAMECAST_HOME, { recursive: true });

  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (isFlamecastProcess(pid)) {
      console.log(`Flamecast is already running (PID ${pid})`);
      return 1;
    }
    unlinkSync(PID_FILE);
  }

  return runServer(flags);
}

async function runServer(flags: UpFlags): Promise<number> {
  const port = flags.port ?? 6769;
  let wrotePidFile = false;

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

    flamecast.attachWebSockets(server);
    writeFileSync(PID_FILE, String(process.pid));
    wrotePidFile = true;
    console.log(`Flamecast is running on port ${port}`);
    if (port === 6769) {
      console.log(`Go to https://flamecast.sh to interact with it.`);
    } else {
      console.log(
        "Note: You are using a custom port; if you run on the default port 6769, you can interact with Flamecast at https://flamecast.sh",
      );
    }

    let cloudflaredProcess: ChildProcess | null = null;
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
          const msg = error instanceof Error ? error.message : String(error);
          console.log(`Tunnel unavailable: ${msg}`);
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
          await new Promise<void>((closeResolve) => {
            server.close(() => {
              closeResolve();
            });
          });
        } catch (error) {
          exitCode = 1;
          console.error(error instanceof Error ? error.message : String(error));
        } finally {
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
    if (wrotePidFile) {
      try {
        unlinkSync(PID_FILE);
      } catch {
        // ignore
      }
    }
    throw error;
  }
}
