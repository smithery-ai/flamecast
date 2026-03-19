export interface ConnectionLog {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ConnectionInfo {
  id: string;
  agentType: string;
  sessionId: string;
  startedAt: string;
  lastUpdatedAt: string;
  logs: ConnectionLog[];
}

export interface PromptResult {
  stopReason: string;
}

export async function fetchConnections(): Promise<ConnectionInfo[]> {
  const res = await fetch("/api/connections");
  if (!res.ok) throw new Error("Failed to fetch connections");
  return res.json();
}

export async function fetchConnection(id: string): Promise<ConnectionInfo> {
  const res = await fetch(`/api/connections/${id}`);
  if (!res.ok) throw new Error("Connection not found");
  return res.json();
}

export async function createConnection(agent: string): Promise<ConnectionInfo> {
  const res = await fetch("/api/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent }),
  });
  if (!res.ok) throw new Error("Failed to create connection");
  return res.json();
}

export async function sendPrompt(id: string, text: string): Promise<PromptResult> {
  const res = await fetch(`/api/connections/${id}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error("Failed to send prompt");
  return res.json();
}

export async function killConnection(id: string): Promise<void> {
  const res = await fetch(`/api/connections/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to kill connection");
}
