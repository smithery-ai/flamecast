// ---------------------------------------------------------------------------
// Shared types for filesystem entries (used by snapshot events)
// ---------------------------------------------------------------------------

export interface FileSystemEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
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
// SessionHost HTTP contract
// ---------------------------------------------------------------------------

export interface SessionHostStartRequest {
  command: string;
  args: string[];
  workspace: string;
  setup?: string;
  callbackUrl?: string;
}

export interface SessionHostStartResponse {
  acpSessionId: string;
  hostUrl: string;
  websocketUrl: string;
}

export interface SessionHostHealthResponse {
  status: "idle" | "running";
  sessionId?: string;
}
