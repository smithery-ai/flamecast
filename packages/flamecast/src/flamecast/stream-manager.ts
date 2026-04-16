import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReadStream } from "node:fs";
import type { WebSocket } from "ws";
import * as tmux from "./sessions/tmux.js";

const exec = promisify(execFile);

interface StreamState {
  sessionId: string;
  clients: Set<WebSocket>;
  fifoPath: string;
  reader: ReadStream | null;
}

export class StreamManager {
  private readonly streams = new Map<string, StreamState>();
  private tmpDir: string | null = null;

  async addClient(sessionId: string, ws: WebSocket): Promise<void> {
    let state = this.streams.get(sessionId);

    if (!state) {
      const fifoPath = await this.createFifo(sessionId);
      state = { sessionId, clients: new Set(), fifoPath, reader: null };
      this.streams.set(sessionId, state);
    }

    state.clients.add(ws);

    // Send current pane content so the client sees existing output
    try {
      const output = await tmux.capturePane(sessionId);
      if (output && ws.readyState === ws.OPEN) {
        ws.send(output);
      }
    } catch {
      // session may not be ready yet
    }

    if (state.clients.size === 1) {
      await this.startPipePane(state);
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

  private async createFifo(sessionId: string): Promise<string> {
    const dir = await this.getTmpDir();
    const fifoPath = join(dir, `${sessionId}.pipe`);
    await exec("mkfifo", [fifoPath]);
    return fifoPath;
  }

  private async startPipePane(state: StreamState): Promise<void> {
    // Tell tmux to pipe pane output into the FIFO
    await exec("tmux", ["pipe-pane", "-o", "-t", state.sessionId, `cat > ${state.fifoPath}`]);

    // Read from the FIFO and broadcast to all clients
    const reader = createReadStream(state.fifoPath);
    state.reader = reader;

    reader.on("data", (chunk: Buffer | string) => {
      for (const client of state.clients) {
        if (client.readyState === client.OPEN) {
          client.send(chunk);
        }
      }
    });

    reader.on("error", () => {
      // FIFO removed or session died
      this.disconnectAll(state.sessionId);
    });
  }

  private async cleanup(state: StreamState): Promise<void> {
    // Stop tmux pipe-pane (no command arg = stop piping)
    try {
      await exec("tmux", ["pipe-pane", "-t", state.sessionId]);
    } catch {
      // session may already be dead
    }

    if (state.reader) {
      state.reader.destroy();
      state.reader = null;
    }

    try {
      await rm(state.fifoPath, { force: true });
    } catch {
      // ignore
    }
  }
}
