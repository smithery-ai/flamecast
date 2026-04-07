// ---------------------------------------------------------------------------
// Shared types for filesystem entries (used by snapshot events)
// ---------------------------------------------------------------------------

export interface FileSystemEntryGitInfo {
  branch: string;
  origin?: string;
}

export interface FileSystemEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  /** Present when the entry is a directory that is a git repository. */
  git?: FileSystemEntryGitInfo;
}

// ---------------------------------------------------------------------------
// SessionHost → Client events
// ---------------------------------------------------------------------------

export interface PermissionRequestEvent {
  requestId: string;
  toolCallId: string;
  title: string;
  kind?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface FilesystemSnapshotEvent {
  snapshot: {
    root: string;
    entries: FileSystemEntry[];
  };
}

export interface FilePreviewEvent {
  path: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Client → SessionHost actions
// ---------------------------------------------------------------------------

export interface PermissionRespondAction {
  action: "permission.respond";
  requestId: string;
  response: { optionId: string };
}

export interface FsSnapshotAction {
  action: "fs.snapshot";
  path?: string;
}

export interface FilePreviewAction {
  action: "file.preview";
  path: string;
}

// ---------------------------------------------------------------------------
// SessionHost → Control Plane callback events
// ---------------------------------------------------------------------------

/** Union of all events the session-host can POST to the control plane. */
export type SessionCallbackEvent =
  | { type: "permission_request"; data: PermissionRequestEvent }
  | { type: "session_end"; data: { exitCode: number | null } }
  | { type: "end_turn"; data: { promptResponse: unknown } }
  | { type: "agent_message"; data: { sessionUpdate: unknown } }
  | { type: "error"; data: { message: string } };

/** Response from the control plane for a permission_request callback. */
export type PermissionCallbackResponse =
  | { optionId: string }
  | { outcome: "cancelled" }
  | { deferred: true };

// ---------------------------------------------------------------------------
// SessionHost HTTP contract
// ---------------------------------------------------------------------------

export interface SessionHostStartRequest {
  /** Flamecast-level session ID (used for callbacks to the control plane). */
  sessionId?: string;
  command: string;
  args: string[];
  workspace: string;
  setup?: string;
  env?: Record<string, string>;
  callbackUrl?: string;
}

export interface SessionHostStartResponse {
  acpSessionId: string;
  /** Set by the runtime after proxying the response from the runtime-host. */
  hostUrl: string;
  /** Set by the runtime after proxying the response from the runtime-host. */
  websocketUrl: string;
  /** The Flamecast-level session ID (echoed back from the runtime-host). */
  sessionId?: string;
}

export interface SessionHostHealthResponse {
  status: "idle" | "running";
  sessionId?: string;
}
