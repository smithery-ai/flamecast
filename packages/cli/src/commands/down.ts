import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { deleteMachineCredentials, readMachineCredentials } from "../lib/credentials.js";
import { deregisterMachine, getMachinesApiUrl } from "../lib/machines-api.js";
import { getFlamecastPaths } from "../lib/paths.js";
import type { DownFlags } from "../types.js";
import { isFlamecastProcess } from "./up.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs = 15_000,
  pollMs = 100,
): Promise<boolean> {
  const startedAt = Date.now();

  while (isProcessAlive(pid)) {
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }

  return true;
}

export async function runDown(flags: DownFlags): Promise<number> {
  const { pidFile, logFile } = getFlamecastPaths();
  let handledRunningProcess = false;

  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);

    if (!isFlamecastProcess(pid)) {
      try {
        unlinkSync(pidFile);
      } catch {
        // ignore
      }

      if (!flags.deregister) {
        console.log("Flamecast is not running (stale PID file removed).");
        return 1;
      }
    } else {
      let alreadyStopped = false;
      try {
        console.log(`Stopping Flamecast (PID ${pid})...`);
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (getErrorCode(error) === "ESRCH") {
          console.log(`Process ${pid} not found (already stopped).`);
          alreadyStopped = true;
        } else {
          console.error(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }

      if (!alreadyStopped) {
        const exited = await waitForProcessExit(pid);
        if (!exited) {
          console.log(`Timed out waiting for Flamecast (PID ${pid}) to stop.`);
          return 1;
        }
      }

      try {
        unlinkSync(pidFile);
      } catch {
        // ignore
      }

      handledRunningProcess = true;
      if (!alreadyStopped) {
        console.log(`Stopped Flamecast (PID ${pid})`);
      }
    }
  } else if (!flags.deregister) {
    console.log("Flamecast is not running.");
    return 1;
  }

  if (flags.deregister) {
    const credentials = readMachineCredentials();
    if (!credentials) {
      if (!handledRunningProcess) {
        console.log("No saved machine registration.");
        return 1;
      }
    } else {
      await deregisterMachine(
        getMachinesApiUrl(),
        credentials.machineId,
        credentials.machineSecret,
      );
      deleteMachineCredentials();
      console.log(`Deregistered ${credentials.subdomain}`);
    }
  }

  console.log(`Logs: ${logFile}`);
  return handledRunningProcess || flags.deregister ? 0 : 1;
}
