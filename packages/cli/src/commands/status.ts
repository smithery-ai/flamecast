import { existsSync, readFileSync } from "node:fs";
import { readMachineCredentials } from "../lib/credentials.js";
import { getMachineDomain, getMachinesApiUrl } from "../lib/machines-api.js";
import { getFlamecastPaths } from "../lib/paths.js";
import { isFlamecastProcess } from "./up.js";

export async function runStatus(): Promise<number> {
  const { pidFile, logFile } = getFlamecastPaths();
  const credentials = readMachineCredentials();

  if (!existsSync(pidFile)) {
    console.log("Flamecast is not running.");
    if (credentials) {
      console.log(
        `Saved machine: https://${getMachineDomain(credentials.subdomain, getMachinesApiUrl())}`,
      );
    }
    return 1;
  }

  const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);

  if (isFlamecastProcess(pid)) {
    console.log(`Flamecast is running (PID ${pid})`);
    if (credentials) {
      console.log(
        `Machine: https://${getMachineDomain(credentials.subdomain, getMachinesApiUrl())}`,
      );
    }
    console.log(`Logs: ${logFile}`);
    return 0;
  }

  console.log("Flamecast is not running (crashed or was killed).");
  console.log("");

  if (existsSync(logFile)) {
    const logs = readFileSync(logFile, "utf8").trim();
    const lines = logs.split("\n");
    const tail = lines.slice(-20).join("\n");
    if (tail) {
      console.log("Last logs:");
      console.log(tail);
    }
  }

  if (credentials) {
    console.log(
      `\nSaved machine: https://${getMachineDomain(credentials.subdomain, getMachinesApiUrl())}`,
    );
  }
  console.log(`\nFull logs: ${logFile}`);
  return 1;
}
