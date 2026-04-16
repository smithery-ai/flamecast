import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import * as tmux from "./tmux.js";
import type {
  Session,
  CreateParams,
  CreateResult,
  ExecParams,
  ExecResult,
  ExecAsyncParams,
  ExecAsyncResult,
  InputParams,
  InputResult,
  GetParams,
  GetResult,
  ListResult,
  CloseParams,
  CloseResult,
} from "./types.js";

const DEFAULT_TIMEOUT = 300;
const REAP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

function generateId(): string {
  return `fc_${randomBytes(4).toString("hex")}`;
}

function streamUrl(sessionId: string): string {
  return `/terminals/${sessionId}/stream`;
}

const KEY_MAP: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  space: "Space",
  backspace: "BSpace",
  delete: "DC",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

function mapKey(key: string): string {
  const lower = key.toLowerCase();
  if (KEY_MAP[lower]) return KEY_MAP[lower];
  const ctrlMatch = lower.match(/^ctrl\+(.+)$/);
  if (ctrlMatch) return `C-${ctrlMatch[1]}`;
  return key;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  async create(params: CreateParams = {}): Promise<CreateResult> {
    const sessionId = generateId();
    const cwd = params.cwd ?? homedir();
    const shell = params.shell ?? process.env.SHELL ?? "/bin/bash";
    const timeout = params.timeout === undefined ? DEFAULT_TIMEOUT : params.timeout;

    await tmux.newSession(sessionId, cwd, shell, params.cols, params.rows);

    const session: Session = {
      sessionId,
      status: "running",
      cwd,
      shell,
      created: new Date(),
      lastActivity: new Date(),
      timeout: timeout === 0 ? null : timeout,
      outputBuffer: "",
      byteOffset: 0,
    };

    this.sessions.set(sessionId, session);
    this.resetTimeout(session);

    return {
      sessionId,
      streamUrl: streamUrl(sessionId),
      cwd,
      shell,
      timeout: session.timeout,
    };
  }

  async exec(params: ExecParams): Promise<ExecResult> {
    let sessionId = params.sessionId ?? null;
    if (!sessionId) {
      const created = await this.create();
      sessionId = created.sessionId;
    }

    const session = await this.getRunningSession(sessionId);
    this.touch(session);

    const timeout = params.timeout ?? 30;
    const sentinel = `__FC_DONE_\${?}__`;

    await tmux.sendKeys(sessionId, `${params.command}; echo ${sentinel}`, false);
    await tmux.sendKeys(sessionId, "Enter");

    const deadline = Date.now() + timeout * 1000;
    let output = "";
    let exitCode: number | null = null;

    while (Date.now() < deadline) {
      await sleep(100);
      const captured = await tmux.capturePane(sessionId);
      const sentinelMatch = captured.match(/__FC_DONE_(\d+)__/);

      if (sentinelMatch) {
        exitCode = parseInt(sentinelMatch[1], 10);
        const lines = captured.split("\n");
        const sentinelIdx = lines.findIndex((l) => /__FC_DONE_\d+__/.test(l));
        output = stripAnsi(lines.slice(0, sentinelIdx).join("\n").trimEnd());
        break;
      }
    }

    this.touch(session);

    return { sessionId, output, exitCode };
  }

  async execAsync(params: ExecAsyncParams): Promise<ExecAsyncResult> {
    let sessionId = params.sessionId ?? null;
    if (!sessionId) {
      const created = await this.create();
      sessionId = created.sessionId;
    }

    const session = await this.getRunningSession(sessionId);
    this.touch(session);

    await tmux.sendKeys(sessionId, params.command, false);
    await tmux.sendKeys(sessionId, "Enter");

    return { sessionId, status: "running" };
  }

  async input(params: InputParams): Promise<InputResult> {
    const session = await this.getRunningSession(params.sessionId);
    this.touch(session);

    if (params.text) {
      await tmux.sendKeys(params.sessionId, params.text, true);
    }

    if (params.keys) {
      for (const key of params.keys) {
        await tmux.sendKeys(params.sessionId, mapKey(key));
      }
    }

    return { sessionId: params.sessionId, sent: true };
  }

  async get(params: GetParams): Promise<GetResult> {
    const session = await this.resolveSession(params.sessionId);
    if (session.status === "running") {
      this.touch(session);
    }

    let output: string;
    if (params.tail != null) {
      output = await tmux.capturePane(params.sessionId, params.tail);
    } else {
      output = await tmux.capturePane(params.sessionId).catch(() => session.outputBuffer);
    }

    if (params.since != null && params.since < output.length) {
      output = output.slice(params.since);
    }

    const currentCwd =
      session.status === "running"
        ? await tmux.getCwd(params.sessionId).catch(() => session.cwd)
        : session.cwd;

    const lines = output.split("\n");

    return {
      sessionId: params.sessionId,
      output,
      lineCount: lines.length,
      byteOffset: Buffer.byteLength(output),
      status: session.status,
      exitCode: null,
      cwd: currentCwd,
      streamUrl: streamUrl(params.sessionId),
    };
  }

  async list(): Promise<ListResult> {
    await this.syncWithTmux();

    return {
      sessions: Array.from(this.sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        status: s.status,
        cwd: s.cwd,
        shell: s.shell,
        created: s.created.toISOString(),
        lastActivity: s.lastActivity.toISOString(),
        timeout: s.timeout,
        streamUrl: streamUrl(s.sessionId),
      })),
    };
  }

  async close(params: CloseParams): Promise<CloseResult> {
    const session = await this.resolveSession(params.sessionId);

    let finalOutput = "";
    try {
      finalOutput = await tmux.capturePane(params.sessionId);
    } catch {
      finalOutput = session.outputBuffer;
    }

    try {
      await tmux.killSession(params.sessionId);
    } catch {
      // already dead
    }

    session.status = "closed";
    session.outputBuffer = finalOutput;
    this.clearTimeout(session);
    this.scheduleReap(session);

    return {
      sessionId: params.sessionId,
      finalOutput,
      status: "closed",
    };
  }

  // --- internals ---

  /**
   * Get a session that must be running. If not in the in-memory map,
   * check tmux and adopt it on-demand (crash recovery).
   */
  private async getRunningSession(sessionId: string): Promise<Session> {
    const session = await this.resolveSession(sessionId);
    if (session.status !== "running") {
      throw new SessionError(`Session ${sessionId} is ${session.status}`, 409);
    }
    return session;
  }

  /**
   * Resolve a session by ID. If we don't have it in memory but tmux does,
   * adopt it lazily.
   */
  private async resolveSession(sessionId: string): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    // Check if tmux has it (crash recovery / external creation)
    if (await tmux.hasSession(sessionId)) {
      const session = await this.adoptSession(sessionId);
      return session;
    }

    throw new SessionError(`Session not found: ${sessionId}`, 404);
  }

  /**
   * Adopt a tmux session we didn't create (e.g. survived a process restart).
   */
  private async adoptSession(sessionId: string): Promise<Session> {
    const cwd = await tmux.getCwd(sessionId).catch(() => homedir());
    const session: Session = {
      sessionId,
      status: "running",
      cwd,
      shell: process.env.SHELL ?? "/bin/bash",
      created: new Date(),
      lastActivity: new Date(),
      timeout: DEFAULT_TIMEOUT,
      outputBuffer: "",
      byteOffset: 0,
    };
    this.sessions.set(sessionId, session);
    this.resetTimeout(session);
    return session;
  }

  /**
   * Sync the in-memory map with tmux: adopt unknown fc_* sessions,
   * mark disappeared ones as exited.
   */
  private async syncWithTmux(): Promise<void> {
    const tmuxSessions = await tmux.listFcSessions();
    const tmuxNames = new Set(tmuxSessions.map((s) => s.name));

    // Adopt sessions in tmux but not in our map
    for (const info of tmuxSessions) {
      if (!this.sessions.has(info.name)) {
        const cwd = await tmux.getCwd(info.name).catch(() => homedir());
        const session: Session = {
          sessionId: info.name,
          status: "running",
          cwd,
          shell: process.env.SHELL ?? "/bin/bash",
          created: new Date(info.created * 1000),
          lastActivity: new Date(info.activity * 1000),
          timeout: DEFAULT_TIMEOUT,
          outputBuffer: "",
          byteOffset: 0,
        };
        this.sessions.set(info.name, session);
        this.resetTimeout(session);
      }
    }

    // Mark sessions that disappeared from tmux as exited
    for (const session of this.sessions.values()) {
      if (session.status === "running" && !tmuxNames.has(session.sessionId)) {
        session.status = "exited";
        this.scheduleReap(session);
      }
    }
  }

  private touch(session: Session): void {
    session.lastActivity = new Date();
    this.resetTimeout(session);
  }

  private resetTimeout(session: Session): void {
    this.clearTimeout(session);
    if (session.timeout != null && session.timeout > 0) {
      session.timeoutTimer = setTimeout(() => {
        void this.expireSession(session);
      }, session.timeout * 1000);
    }
  }

  private clearTimeout(session: Session): void {
    if (session.timeoutTimer) {
      globalThis.clearTimeout(session.timeoutTimer);
      session.timeoutTimer = undefined;
    }
  }

  private async expireSession(session: Session): Promise<void> {
    try {
      session.outputBuffer = await tmux.capturePane(session.sessionId);
    } catch {
      // ok
    }
    try {
      await tmux.killSession(session.sessionId);
    } catch {
      // already dead
    }
    session.status = "expired";
    this.scheduleReap(session);
  }

  private scheduleReap(session: Session): void {
    setTimeout(() => {
      this.sessions.delete(session.sessionId);
    }, REAP_DELAY_MS);
  }
}

export class SessionError extends Error {
  readonly statusCode: 400 | 404 | 409 | 500;

  constructor(message: string, statusCode: 400 | 404 | 409 | 500) {
    super(message);
    this.name = "SessionError";
    this.statusCode = statusCode;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
