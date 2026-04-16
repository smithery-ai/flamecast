import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { PID_FILE, isFlamecastProcess } from "./up.js";

export async function runStatus(): Promise<number> {
  if (!existsSync(PID_FILE)) {
    console.log("Flamecast is not running.");
    return 1;
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);

  if (isFlamecastProcess(pid)) {
    console.log(`Flamecast is running (PID ${pid})`);
    return 0;
  }

  try {
    unlinkSync(PID_FILE);
  } catch {
    // ignore
  }

  console.log("Flamecast is not running (stale PID file removed).");
  return 1;
}
