import { API_BASE } from "#/lib/app-info";

export interface TerminalSession {
  sessionId: string;
  status: "running" | "exited" | "expired" | "closed";
  cwd: string;
  shell: string;
  created: string;
  lastActivity: string;
  timeout: number | null;
  streamUrl: string;
}

export async function fetchSessions(): Promise<TerminalSession[]> {
  const res = await fetch(`${API_BASE}/api/terminals`);
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  const data: { sessions: TerminalSession[] } = await res.json();
  return data.sessions;
}

export async function createSession(cols: number, rows: number): Promise<string> {
  const res = await fetch(`${API_BASE}/api/terminals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeout: 0, cols, rows }),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  const data: { sessionId: string } = await res.json();
  return data.sessionId;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/terminals/${sessionId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete session: ${res.status}`);
}
