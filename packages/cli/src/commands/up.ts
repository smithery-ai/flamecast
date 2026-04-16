import { execSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { serve } from "@hono/node-server";
import { Flamecast } from "@flamecast/sdk";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { MachineCredentials } from "../lib/credentials.js";
import { readMachineCredentials, writeMachineCredentials } from "../lib/credentials.js";
import {
  getMachineDomain,
  getMachinesApiUrl,
  pollMachineRegistration,
  sendMachineHeartbeat,
  startMachineRegistration,
} from "../lib/machines-api.js";
import { getFlamecastPaths } from "../lib/paths.js";
import { ensureCloudflared, spawnCloudflared } from "../lib/cloudflared.js";
import type { UpFlags } from "../types.js";

const LINK_TIMEOUT_MS = 5 * 60_000;
const LINK_POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

type IpcMsg =
  | { type: "ready" }
  | { type: "error"; error: string }
  | { type: "link-pending"; verificationUrl: string }
  | { type: "linked"; domain: string }
  | { type: "link-error"; error: string };

type LinkRuntime = {
  cloudflaredProcess: ChildProcess;
  stopHeartbeat: () => void;
  domain: string;
};

export { isFlamecastProcess };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMachineApproval(
  machinesUrl: string,
  deviceCode: string,
): Promise<Omit<MachineCredentials, "subdomain">> {
  const deadline = Date.now() + LINK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = await pollMachineRegistration(machinesUrl, deviceCode);
    if (result.status === "approved") {
      return {
        machineId: result.machineId,
        machineSecret: result.machineSecret,
        tunnelToken: result.tunnelToken,
      };
    }

    if (result.status === "expired") {
      throw new Error("Machine approval expired before it was completed");
    }

    await sleep(LINK_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for machine approval");
}

function startHeartbeatLoop(machinesUrl: string, credentials: MachineCredentials): () => void {
  let stopped = false;

  async function sendHeartbeat(): Promise<void> {
    if (stopped) {
      return;
    }

    try {
      await sendMachineHeartbeat(machinesUrl, credentials.machineId, credentials.machineSecret);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Heartbeat failed: ${message}`);
    }
  }

  void sendHeartbeat();

  const timer = setInterval(() => {
    void sendHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function resolveMachineCredentials(
  machinesUrl: string,
  subdomain: string,
  onVerificationUrl: (verificationUrl: string) => void,
): Promise<MachineCredentials> {
  const existingCredentials = readMachineCredentials();
  if (existingCredentials) {
    if (existingCredentials.subdomain !== subdomain) {
      throw new Error(
        `Flamecast is already linked as ${existingCredentials.subdomain}. Run 'flamecast down --deregister' before linking a different machine.`,
      );
    }

    return existingCredentials;
  }

  const registration = await startMachineRegistration(machinesUrl, subdomain);
  onVerificationUrl(registration.verificationUrl);

  const approved = await waitForMachineApproval(machinesUrl, registration.deviceCode);
  const credentials: MachineCredentials = { ...approved, subdomain };
  writeMachineCredentials(credentials);
  return credentials;
}

async function connectMachine(
  machinesUrl: string,
  subdomain: string,
  onVerificationUrl: (verificationUrl: string) => void,
): Promise<LinkRuntime> {
  const credentials = await resolveMachineCredentials(machinesUrl, subdomain, onVerificationUrl);
  const cloudflaredProcess = spawnCloudflared(credentials.tunnelToken);
  const stopHeartbeat = startHeartbeatLoop(machinesUrl, credentials);

  return {
    cloudflaredProcess,
    stopHeartbeat,
    domain: getMachineDomain(subdomain, machinesUrl),
  };
}

function isFlamecastProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // The process exists, but verify it's actually a Flamecast process.
  try {
    const cmd =
      platform() === "darwin"
        ? `ps -p ${pid} -o command=`
        : `cat /proc/${pid}/cmdline 2>/dev/null || ps -p ${pid} -o args=`;
    const output = execSync(cmd, { timeout: 2000 }).toString();
    return output.includes("flamecast");
  } catch {
    return false;
  }
}

export async function runUp(flags: UpFlags): Promise<number> {
  if (process.env.__FLAMECAST_DAEMON === "1") {
    return runServer(flags);
  }

  return daemonize(flags);
}

async function daemonize(flags: UpFlags): Promise<number> {
  const { homeDir, logFile, pidFile } = getFlamecastPaths();
  mkdirSync(homeDir, { recursive: true });

  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (isFlamecastProcess(pid)) {
      console.log(`Flamecast is already running (PID ${pid})`);
      console.log(`Logs: ${logFile}`);
      return 1;
    }

    unlinkSync(pidFile);
  }

  const existingCredentials = readMachineCredentials();
  if (flags.name && existingCredentials && existingCredentials.subdomain !== flags.name) {
    console.error(
      `Flamecast is already linked as ${existingCredentials.subdomain}. Run 'flamecast down --deregister' before linking ${flags.name}.`,
    );
    return 1;
  }

  if (flags.name && flags.port && flags.port !== 3000) {
    console.error("Linked mode only supports port 3000 with the Machines API.");
    return 1;
  }

  if (flags.name && !(await ensureCloudflared())) {
    flags = { ...flags, name: undefined };
  }

  const logFd = openSync(logFile, "w");
  const childArgs = [process.argv[1], "up"];
  if (flags.name) {
    childArgs.push("--name", flags.name);
  }
  if (flags.port) {
    childArgs.push("--port", String(flags.port));
  }

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

  const queuedMessages: IpcMsg[] = [];
  let exitCode: number | null | undefined;
  let waiter: ((result: IpcMsg | { type: "exit"; code: number | null }) => void) | undefined;

  child.on("message", (message: IpcMsg) => {
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(message);
      return;
    }

    queuedMessages.push(message);
  });

  child.on("exit", (code) => {
    exitCode = code;
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve({ type: "exit", code });
    }
  });

  function waitForEvent(
    timeoutMs: number,
  ): Promise<IpcMsg | { type: "exit"; code: number | null } | { type: "timeout" }> {
    if (queuedMessages.length > 0) {
      const next = queuedMessages.shift();
      if (next) {
        return Promise.resolve(next);
      }
    }

    if (exitCode !== undefined) {
      return Promise.resolve({ type: "exit", code: exitCode });
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (waiter) {
          waiter = undefined;
        }
        resolve({ type: "timeout" });
      }, timeoutMs);

      waiter = (result) => {
        clearTimeout(timeout);
        resolve(result);
      };
    });
  }

  const first = await waitForEvent(30_000);

  if (first.type === "error") {
    child.disconnect();
    child.unref();
    console.error(`Failed to start Flamecast: ${first.error}`);
    return 1;
  }

  if (first.type === "exit") {
    console.error(
      `Failed to start Flamecast: process exited with code ${first.code}. Check logs: ${logFile}`,
    );
    return 1;
  }

  if (first.type === "timeout") {
    child.disconnect();
    child.unref();
    console.error("Failed to start Flamecast: timed out waiting for server to start");
    return 1;
  }

  const port = flags.port ?? 3000;
  let linkedDomain: string | undefined;
  console.log(`Logs: ${logFile}`);

  if (flags.name) {
    console.log("Linking machine...");
    const deadline = Date.now() + LINK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const event = await waitForEvent(deadline - Date.now());
      if (event.type === "link-pending") {
        console.log(`Approve this machine in your browser: ${event.verificationUrl}`);
        console.log("Waiting for approval...");
        continue;
      }

      if (event.type === "linked") {
        linkedDomain = event.domain;
        break;
      }

      if (event.type === "link-error") {
        console.error(`Link failed: ${event.error}`);
        console.log("Running locally only.");
        break;
      }

      if (event.type === "exit") {
        console.error(
          `Link failed: process exited with code ${event.code}. Check logs: ${logFile}`,
        );
        break;
      }

      console.error("Link timed out.");
      console.log("Running locally only.");
      break;
    }
  }

  child.disconnect();
  child.unref();

  console.log(`\nFlamecast started (PID ${child.pid})`);
  console.log(`  Local:  http://localhost:${port}`);
  if (linkedDomain) {
    console.log(`  Machine: https://${linkedDomain}`);
  }

  return 0;
}

async function runServer(flags: UpFlags): Promise<number> {
  const { homeDir, pidFile } = getFlamecastPaths();
  const port = flags.port ?? 3000;
  let wrotePidFile = false;

  try {
    mkdirSync(homeDir, { recursive: true });

    const flamecast = new Flamecast();
    const wrapper = new Hono();
    wrapper.use("*", cors());
    wrapper.all("*", (c) => flamecast.app.fetch(c.req.raw));

    const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const instance = serve({ fetch: wrapper.fetch, port }, () => {
        resolve(instance);
      });
      instance.on("error", (error: NodeJS.ErrnoException) => {
        reject(error);
      });
    });

    flamecast.attachWebSockets(server);
    writeFileSync(pidFile, String(process.pid));
    wrotePidFile = true;
    console.log(`Flamecast running on http://localhost:${port}`);

    if (process.send) {
      process.send({ type: "ready" });
    }

    let cloudflaredProcess: ChildProcess | null = null;
    let stopHeartbeat: (() => void) | null = null;

    if (flags.name) {
      if (!(await ensureCloudflared())) {
        console.log("Running locally only.");
        if (process.send) {
          process.send({ type: "link-error", error: "cloudflared not available" });
        }
      } else {
        try {
          const machinesUrl = getMachinesApiUrl();
          const link = await connectMachine(machinesUrl, flags.name, (verificationUrl) => {
            if (process.send) {
              process.send({ type: "link-pending", verificationUrl });
              return;
            }

            console.log(`Approve this machine in your browser: ${verificationUrl}`);
            console.log("Waiting for approval...");
          });
          cloudflaredProcess = link.cloudflaredProcess;
          stopHeartbeat = link.stopHeartbeat;
          console.log(`Linked as https://${link.domain}`);
          if (process.send) {
            process.send({ type: "linked", domain: link.domain });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`Link unavailable: ${message}`);
          console.log("Running locally only.");
          if (process.send) {
            process.send({ type: "link-error", error: message });
          }
        }
      }
    }

    return await new Promise<number>((resolve) => {
      let shuttingDown = false;

      async function shutdown(): Promise<void> {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        let exitCode = 0;

        console.log("\nShutting down...");
        try {
          if (stopHeartbeat) {
            stopHeartbeat();
          }
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
            unlinkSync(pidFile);
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
    const message = error instanceof Error ? error.message : String(error);
    if (process.send) {
      process.send({ type: "error", error: message });
    }
    if (wrotePidFile) {
      try {
        unlinkSync(pidFile);
      } catch {
        // ignore
      }
    }
    throw error;
  }
}
