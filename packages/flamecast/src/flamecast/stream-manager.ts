import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ChildProcess } from "node:child_process";
import type { WebSocket } from "ws";
import * as tmux from "./sessions/tmux.js";
import { serializeTerminalSnapshot } from "./terminal-snapshot.js";

const exec = promisify(execFile);

interface StreamState {
  sessionId: string;
  clients: Set<WebSocket>;
  outFile: string;
  tail: ChildProcess | null;
  pendingOutput: string;
}

function formatPaneSnapshot(snapshot: tmux.PaneSnapshot): string {
  return serializeTerminalSnapshot(snapshot.output, snapshot.cursorX, snapshot.cursorY);
}

export class StreamManager {
  private readonly streams = new Map<string, StreamState>();
  private tmpDir: string | null = null;

  async addClient(sessionId: string, ws: WebSocket): Promise<void> {
    let state = this.streams.get(sessionId);

    if (!state) {
      const dir = await this.getTmpDir();
      const outFile = join(dir, `${sessionId}.out`);
      await writeFile(outFile, "");
      state = { sessionId, clients: new Set(), outFile, tail: null, pendingOutput: "" };
      this.streams.set(sessionId, state);
    }

    state.clients.add(ws);

    // Replay the current pane so a newly attached client sees the existing prompt/output.
    try {
      const output = formatPaneSnapshot(await tmux.captureTerminalSnapshot(sessionId));
      if (output && ws.readyState === ws.OPEN) {
        ws.send(output);
      }
    } catch {
      // session may not be ready yet
    }

    if (state.clients.size === 1) {
      await this.startStream(state);
    }

    ws.on("close", () => this.removeClient(sessionId, ws));
    ws.on("error", () => this.removeClient(sessionId, ws));
  }

  async handleMessage(sessionId: string, data: Buffer | string): Promise<void> {
    const msg = typeof data === "string" ? data : data.toString("utf-8");

    try {
      const parsed = JSON.parse(msg);
      if (
        parsed.type === "resize" &&
        typeof parsed.cols === "number" &&
        typeof parsed.rows === "number"
      ) {
        await tmux.resizeWindow(sessionId, parsed.cols, parsed.rows);
        return;
      }
    } catch {
      // Not JSON — treat as raw keystrokes
    }

    await tmux.sendKeys(sessionId, msg, true);
  }

  disconnectAll(sessionId: string): void {
    const state = this.streams.get(sessionId);
    if (!state) return;
    void this.cleanup(state);
    for (const client of state.clients) {
      try {
        client.close(1001, "session closed");
      } catch {
        // ignore
      }
    }
    state.clients.clear();
    this.streams.delete(sessionId);
  }

  private removeClient(sessionId: string, ws: WebSocket): void {
    const state = this.streams.get(sessionId);
    if (!state) return;
    state.clients.delete(ws);
    if (state.clients.size === 0) {
      void this.cleanup(state);
      this.streams.delete(sessionId);
    }
  }

  private async getTmpDir(): Promise<string> {
    if (!this.tmpDir) {
      this.tmpDir = await mkdtemp(join(tmpdir(), "flamecast-"));
    }
    return this.tmpDir;
  }

  private async startStream(state: StreamState): Promise<void> {
    // Pipe tmux pane output to a temp file
    await exec("tmux", ["pipe-pane", "-o", "-t", state.sessionId, `cat >> ${state.outFile}`]);

    // Use tail -f to stream the file contents to WebSocket clients
    const tail = spawn("tail", ["-f", state.outFile], { stdio: ["ignore", "pipe", "ignore"] });
    state.tail = tail;

    tail.stdout.on("data", (chunk: Buffer) => {
      const output = this.stripUnsupportedSequences(state, chunk.toString("utf-8"));
      if (!output) {
        return;
      }
      for (const client of state.clients) {
        if (client.readyState === client.OPEN) {
          client.send(output);
        }
      }
    });

    tail.on("exit", () => {
      if (this.streams.has(state.sessionId)) {
        this.disconnectAll(state.sessionId);
      }
    });
  }

  private async cleanup(state: StreamState): Promise<void> {
    try {
      await exec("tmux", ["pipe-pane", "-t", state.sessionId]);
    } catch {
      // session may already be dead
    }

    if (state.tail) {
      state.tail.kill();
      state.tail = null;
    }
    state.pendingOutput = "";

    try {
      await rm(state.outFile, { force: true });
    } catch {
      // ignore
    }
  }

  private stripUnsupportedSequences(state: StreamState, chunk: string): string {
    const input = state.pendingOutput + chunk;
    let output = "";
    let start = 0;

    while (start < input.length) {
      const sequenceStart = input.indexOf("\x1bk", start);
      if (sequenceStart === -1) {
        output += input.slice(start);
        state.pendingOutput = "";
        return output;
      }

      output += input.slice(start, sequenceStart);
      const sequenceEnd = input.indexOf("\x1b\\", sequenceStart + 2);
      if (sequenceEnd === -1) {
        state.pendingOutput = input.slice(sequenceStart);
        return output;
      }

      start = sequenceEnd + 2;
    }

    state.pendingOutput = "";
    return output;
  }
}
