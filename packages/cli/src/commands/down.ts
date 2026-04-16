import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { PID_FILE, isFlamecastProcess } from "./up.js";

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
  timeoutMs = 10_000,
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

export async function runDown(): Promise<number> {
  if (!existsSync(PID_FILE)) {
    console.log("Flamecast is not running.");
    return 1;
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);

  if (!isFlamecastProcess(pid)) {
    try {
      unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
    console.log("Flamecast is not running (stale PID file removed).");
    return 1;
  }

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
    unlinkSync(PID_FILE);
  } catch {
    // ignore
  }

  if (!alreadyStopped) {
    console.log(`Stopped Flamecast (PID ${pid})`);
  }
  return 0;
}
