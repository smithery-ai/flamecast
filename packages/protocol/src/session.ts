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
}

export interface AgentTemplate {
  id: string;
  name: string;
  spawn: AgentSpawn;
  runtime: AgentTemplateRuntime;
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
}

// ---------------------------------------------------------------------------
// API request bodies
// ---------------------------------------------------------------------------

export interface CreateSessionBody {
  cwd?: string;
  agentTemplateId?: string;
  spawn?: AgentSpawn;
  name?: string;
}

export interface RegisterAgentTemplateBody {
  name: string;
  spawn: AgentSpawn;
  runtime?: AgentTemplateRuntime;
}

export interface PromptBody {
  text: string;
}

export type PermissionResponseBody = { optionId: string } | { outcome: "cancelled" };
