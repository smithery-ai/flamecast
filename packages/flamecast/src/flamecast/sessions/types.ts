export type SessionStatus = "running" | "exited" | "expired" | "closed";

export interface Session {
  sessionId: string;
  status: SessionStatus;
  cwd: string;
  shell: string;
  created: Date;
  lastActivity: Date;
  timeout: number | null;
  outputBuffer: string;
  byteOffset: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

export interface CreateParams {
  cwd?: string;
  shell?: string;
  timeout?: number | null;
  cols?: number;
  rows?: number;
}

export interface CreateResult {
  sessionId: string;
  streamUrl: string;
  cwd: string;
  shell: string;
  timeout: number | null;
}

export interface ExecParams {
  command: string;
  sessionId?: string | null;
  timeout?: number;
}

export interface ExecResult {
  sessionId: string;
  output: string;
  exitCode: number | null;
}

export interface ExecAsyncParams {
  command: string;
  sessionId?: string | null;
}

export interface ExecAsyncResult {
  sessionId: string;
  status: "running";
}

export interface InputParams {
  sessionId: string;
  text?: string | null;
  keys?: string[] | null;
}

export interface InputResult {
  sessionId: string;
  sent: boolean;
}

export interface GetParams {
  sessionId: string;
  tail?: number | null;
  since?: number | null;
}

export interface GetResult {
  sessionId: string;
  output: string;
  terminalOutput?: string;
  lineCount: number;
  byteOffset: number;
  status: SessionStatus;
  exitCode: number | null;
  cwd: string;
  streamUrl: string;
}

export interface ListResult {
  sessions: Array<{
    sessionId: string;
    status: SessionStatus;
    cwd: string;
    shell: string;
    created: string;
    lastActivity: string;
    timeout: number | null;
    streamUrl: string;
  }>;
}

export interface CloseParams {
  sessionId: string;
}

export interface CloseResult {
  sessionId: string;
  finalOutput: string;
  status: "closed";
}
