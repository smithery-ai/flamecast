import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { deleteMachineCredentials, readMachineCredentials } from "../lib/credentials.js";
import { deregisterMachine, getMachinesApiUrl } from "../lib/machines-api.js";
import { getFlamecastPaths } from "../lib/paths.js";
import type { DownFlags } from "../types.js";
import { isFlamecastProcess } from "./up.js";

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isFlamecastProcess(pid)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function runDown(flags: DownFlags): Promise<number> {
  const { pidFile, logFile } = getFlamecastPaths();
  let stoppedProcess = false;

  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);

    try {
      process.kill(pid, "SIGTERM");
      console.log(`Stopped Flamecast (PID ${pid})`);
      stoppedProcess = true;
      await waitForExit(pid, 15_000);
    } catch {
      console.log(`Process ${pid} not found (already stopped).`);
    }

    try {
      unlinkSync(pidFile);
    } catch {
      // ignore
    }
  } else if (!flags.deregister) {
    console.log("Flamecast is not running.");
    return 1;
  }

  if (flags.deregister) {
    const credentials = readMachineCredentials();
    if (!credentials) {
      if (!stoppedProcess) {
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
  return stoppedProcess || flags.deregister ? 0 : 1;
}
