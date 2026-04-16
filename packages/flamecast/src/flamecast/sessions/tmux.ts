import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface PaneSnapshot {
  output: string;
  cursorX: number;
  cursorY: number;
}

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

export async function newSession(
  sessionId: string,
  cwd: string,
  shell: string,
  cols?: number,
  rows?: number,
): Promise<void> {
  const args = ["new-session", "-d", "-s", sessionId, "-c", cwd];
  if (cols != null && rows != null) {
    args.push("-x", String(cols), "-y", String(rows));
  }
  args.push(shell);
  await exec("tmux", args);
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

export async function captureTerminalSnapshot(sessionId: string): Promise<PaneSnapshot> {
  const [{ stdout: output }, { stdout: cursorStdout }] = await Promise.all([
    exec("tmux", ["capture-pane", "-e", "-p", "-t", sessionId]),
    exec("tmux", ["display-message", "-p", "-t", sessionId, "#{cursor_x} #{cursor_y}"]),
  ]);

  const [cursorXText, cursorYText] = cursorStdout.trim().split(" ");
  const cursorX = parseInt(cursorXText, 10);
  const cursorY = parseInt(cursorYText, 10);
  if (Number.isNaN(cursorX) || Number.isNaN(cursorY)) {
    throw new Error(`Failed to parse tmux cursor position: ${cursorStdout}`);
  }

  return { output, cursorX, cursorY };
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

export async function getWindowSize(sessionId: string): Promise<{ cols: number; rows: number }> {
  const { stdout } = await exec("tmux", [
    "display-message",
    "-p",
    "-t",
    sessionId,
    "#{window_width} #{window_height}",
  ]);
  const [colsText, rowsText] = stdout.trim().split(" ");
  const cols = parseInt(colsText, 10);
  const rows = parseInt(rowsText, 10);
  if (Number.isNaN(cols) || Number.isNaN(rows)) {
    throw new Error(`Failed to parse tmux window size: ${stdout}`);
  }
  return { cols, rows };
}
