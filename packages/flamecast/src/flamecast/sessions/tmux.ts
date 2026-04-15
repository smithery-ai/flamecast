import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function checkTmux(): Promise<void> {
  try {
    await exec("tmux", ["-V"]);
  } catch {
    throw new Error(
      "tmux is required but not found in $PATH. Install it:\n" +
        "  macOS:  brew install tmux\n" +
        "  Linux:  apt install tmux",
    );
  }
}

export async function newSession(sessionId: string, cwd: string, shell: string): Promise<void> {
  await exec("tmux", ["new-session", "-d", "-s", sessionId, "-c", cwd, shell]);
}

export async function hasSession(sessionId: string): Promise<boolean> {
  try {
    await exec("tmux", ["has-session", "-t", sessionId]);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(sessionId: string): Promise<void> {
  await exec("tmux", ["kill-session", "-t", sessionId]);
}

export async function capturePane(sessionId: string, tail?: number): Promise<string> {
  const args = ["capture-pane", "-p", "-t", sessionId];
  if (tail != null) {
    args.push("-S", `-${tail}`);
  }
  const { stdout } = await exec("tmux", args);
  return stdout;
}

export async function sendKeys(sessionId: string, keys: string, literal = false): Promise<void> {
  const args = ["send-keys", "-t", sessionId];
  if (literal) args.push("-l");
  args.push(keys);
  await exec("tmux", args);
}

export async function listFcSessions(): Promise<
  Array<{ name: string; created: number; activity: number }>
> {
  try {
    const { stdout } = await exec("tmux", [
      "list-sessions",
      "-F",
      "#{session_name} #{session_created} #{session_activity}",
    ]);
    return stdout
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("fc_"))
      .map((line) => {
        const parts = line.split(" ");
        return {
          name: parts[0],
          created: parseInt(parts[1], 10),
          activity: parseInt(parts[2], 10),
        };
      });
  } catch {
    // No tmux server running = no sessions
    return [];
  }
}

export async function getPanePid(sessionId: string): Promise<number | null> {
  try {
    const { stdout } = await exec("tmux", ["list-panes", "-t", sessionId, "-F", "#{pane_pid}"]);
    const pid = parseInt(stdout.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export async function getCwd(sessionId: string): Promise<string> {
  const pid = await getPanePid(sessionId);
  if (pid == null) return process.cwd();

  try {
    if (process.platform === "darwin") {
      const { stdout } = await exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      const line = stdout.split("\n").find((l) => l.startsWith("n"));
      return line ? line.slice(1) : process.cwd();
    }
    // Linux: /proc/<pid>/cwd
    const { stdout } = await exec("readlink", [`/proc/${pid}/cwd`]);
    return stdout.trim() || process.cwd();
  } catch {
    return process.cwd();
  }
}

export async function resizeWindow(sessionId: string, cols: number, rows: number): Promise<void> {
  await exec("tmux", ["resize-window", "-t", sessionId, "-x", String(cols), "-y", String(rows)]);
}

