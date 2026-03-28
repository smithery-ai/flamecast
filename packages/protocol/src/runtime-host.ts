// ---------------------------------------------------------------------------
// RuntimeHost HTTP contract
//
// A runtime-host is a long-lived process managing multiple sessions within a
// single runtime instance (e.g. one per Docker container or E2B sandbox).
// It exposes a single WebSocket endpoint implementing the ws-channels protocol
// and session-scoped HTTP endpoints under /sessions/{sessionId}/...
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface RuntimeHostStartSessionRequest {
  sessionId: string;
  command: string;
  args: string[];
  workspace: string;
  setup?: string;
  env?: Record<string, string>;
  callbackUrl?: string;
}

export interface RuntimeHostStartSessionResponse {
  acpSessionId: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface RuntimeHostSessionStatus {
  sessionId: string;
  status: "idle" | "running";
}

export interface RuntimeHostHealthResponse {
  status: "ok";
  sessions: RuntimeHostSessionStatus[];
}

// ---------------------------------------------------------------------------
// Prompt / Permission (session-scoped, same shape as before)
// ---------------------------------------------------------------------------

export interface RuntimeHostPromptRequest {
  text: string;
}

export interface RuntimeHostPermissionResponse {
  optionId?: string;
  outcome?: "cancelled";
}
