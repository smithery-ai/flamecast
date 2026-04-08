import { existsSync, readFileSync } from "node:fs";
import { PID_FILE, LOG_FILE, isFlamecastProcess } from "./up.js";

export async function runStatus(): Promise<number> {
  if (!existsSync(PID_FILE)) {
    console.log("Flamecast is not running.");
    return 1;
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);

  if (isFlamecastProcess(pid)) {
    console.log(`Flamecast is running (PID ${pid})`);
    console.log(`Logs: ${LOG_FILE}`);
    return 0;
  }

  // PID file exists but process is gone — it crashed or was killed
  console.log("Flamecast is not running (crashed or was killed).");
  console.log("");

  if (existsSync(LOG_FILE)) {
    const logs = readFileSync(LOG_FILE, "utf8").trim();
    const lines = logs.split("\n");
    const tail = lines.slice(-20).join("\n");
    if (tail) {
      console.log("Last logs:");
      console.log(tail);
    }
  }

  console.log(`\nFull logs: ${LOG_FILE}`);
  return 1;
}
