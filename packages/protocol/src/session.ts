import type { FileSystemEntry } from "./session-host.js";

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface AgentSpawn {
  command: string;
  args: string[];
}

export interface AgentTemplateRuntime {
  provider: string;
  image?: string;
  dockerfile?: string;
  setup?: string;
  env?: Record<string, string>;
}

export interface AgentTemplate {
  id: string;
  name: string;
  spawn: AgentSpawn;
  runtime: AgentTemplateRuntime;
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Session state (API responses + WS events)
// ---------------------------------------------------------------------------

export interface SessionLog {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export interface PendingPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PendingPermission {
  requestId: string;
  toolCallId: string;
  title: string;
  kind?: string;
  options: PendingPermissionOption[];
}

export interface FileSystemSnapshot {
  root: string;
  /** The absolute path of the directory being listed. Absent for legacy recursive snapshots. */
  path?: string;
  entries: FileSystemEntry[];
  truncated: boolean;
  maxEntries: number;
}

export interface FilePreview {
  path: string;
  content: string;
  truncated: boolean;
  maxChars: number;
}

export interface QueuedPromptResponse {
  queued: true;
  queueId: string;
  position: number;
}

export interface PromptQueueItem {
  queueId: string;
  text: string;
  enqueuedAt: string;
  position: number;
}

export interface PromptQueueState {
  processing: boolean;
  paused: boolean;
  items: PromptQueueItem[];
  size: number;
}

export interface Session {
  id: string;
  agentName: string;
  spawn: AgentSpawn;
  startedAt: string;
  lastUpdatedAt: string;
  status: "active" | "killed";
  logs: SessionLog[];
  pendingPermission: PendingPermission | null;
  fileSystem: FileSystemSnapshot | null;
  promptQueue: PromptQueueState | null;
  websocketUrl?: string;
  /** Runtime instance name this session is scoped to. */
  runtime?: string;
}

// ---------------------------------------------------------------------------
// API request bodies
// ---------------------------------------------------------------------------

export interface CreateSessionBody {
  cwd?: string;
  agentTemplateId?: string;
  spawn?: AgentSpawn;
  name?: string;
  /** Runtime instance name to run this session on. Required for multi-instance runtimes. */
  runtimeInstance?: string;
  webhooks?: Omit<WebhookConfig, "id">[];
}

export interface RegisterAgentTemplateBody {
  name: string;
  spawn: AgentSpawn;
  runtime?: AgentTemplateRuntime;
  env?: Record<string, string>;
}

export interface PromptBody {
  text: string;
}

export type PermissionResponseBody = { optionId: string } | { outcome: "cancelled" };

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

/** Event types deliverable via webhooks. */
export type WebhookEventType = "permission_request" | "end_turn" | "error" | "session_end";

/** Webhook registration — per-session or global. */
export interface WebhookConfig {
  /** Stable internal ID assigned at registration. */
  id: string;
  url: string;
  secret: string;
  events?: WebhookEventType[];
}

/** Payload delivered to webhook endpoints. */
export interface WebhookPayload {
  sessionId: string;
  eventId: string;
  timestamp: string;
  event: {
    type: WebhookEventType;
    data: Record<string, unknown>;
  };
}
