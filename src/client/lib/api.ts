import type { AgentType, ConnectionInfo } from "../../shared/connection";

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

export async function createConnection(agent: AgentType): Promise<ConnectionInfo> {
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

export async function respondToPermission(
  connectionId: string,
  requestId: string,
  body: { optionId: string } | { outcome: "cancelled" },
): Promise<void> {
  const res = await fetch(
    `/api/connections/${connectionId}/permissions/${requestId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error("Failed to respond to permission");
}
