// Supported agent backends that Flamecast can launch.
export const agentTypes = ["codex", "example"] as const;
export type AgentType = (typeof agentTypes)[number];

// Log entry surfaced to the client for connection activity.
export interface ConnectionLog {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

// User-selectable option for a pending permission request.
export interface PendingPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

// Serializable permission request details shown in the UI.
export interface PendingPermission {
  requestId: string;
  toolCallId: string;
  title: string;
  kind?: string;
  options: PendingPermissionOption[];
}

// Serializable connection payload shared by the server and client.
export interface ConnectionInfo {
  id: string;
  agentType: AgentType;
  sessionId: string;
  startedAt: string;
  lastUpdatedAt: string;
  logs: ConnectionLog[];
  pendingPermission: PendingPermission | null;
}
