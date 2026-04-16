import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-app.js";
import { waitForProcessExit } from "../src/commands/down.js";

const childProcesses: ChildProcess[] = [];

function getPid(child: ChildProcess): number {
  if (child.pid === undefined) {
    throw new Error("Child process did not start");
  }
  return child.pid;
}

async function spawnReadyProcess(script: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  childProcesses.push(child);

  await new Promise<void>((resolve, reject) => {
    let output = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("ready")) {
        resolve();
      }
    });

    child.once("exit", (code) => {
      reject(new Error(`Child exited before becoming ready (code ${code})`));
    });
    child.once("error", reject);
  });

  return child;
}

afterEach(() => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
});

describe("parseCliArgs", () => {
  it("defaults to up with empty flags", () => {
    expect(parseCliArgs([])).toEqual({ kind: "up", flags: {} });
  });

  it("parses the foreground lifecycle commands", () => {
    expect(parseCliArgs(["up", "--name", "demo", "--port", "4312"])).toEqual({
      kind: "up",
      flags: { name: "demo", port: 4312 },
    });
    expect(parseCliArgs(["down"])).toEqual({ kind: "down" });
    expect(parseCliArgs(["status"])).toEqual({ kind: "status" });
  });
});

describe("waitForProcessExit", () => {
  it("waits until a process exits after SIGTERM", async () => {
    const child = await spawnReadyProcess(
      "process.stdout.write('ready\\n'); process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150)); setInterval(() => {}, 1000);",
    );
    const pid = getPid(child);
    process.kill(pid, "SIGTERM");

    const exited = await waitForProcessExit(pid, 2_000, 20);

    expect(exited).toBe(true);
  });

  it("times out when the process does not exit", async () => {
    await expect(waitForProcessExit(process.pid, 150, 20)).resolves.toBe(false);
  });
});
