import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { PID_FILE, LOG_FILE } from "./up.js";

export async function runDown(): Promise<number> {
  if (!existsSync(PID_FILE)) {
    console.log("Flamecast is not running.");
    return 1;
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped Flamecast (PID ${pid})`);
  } catch {
    console.log(`Process ${pid} not found (already stopped).`);
  }

  try {
    unlinkSync(PID_FILE);
  } catch {
    // ignore
  }

  console.log(`Logs: ${LOG_FILE}`);
  return 0;
}
