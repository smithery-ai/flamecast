import { hc } from "hono/client";
import type { AppType } from "@/flamecast/api";
import {
  SessionLogSchema,
  type AgentTemplate,
  type CreateSessionBody,
  type FilePreview,
  type PermissionResponseBody,
  type QueuedPromptResponse,
  type RegisterAgentTemplateBody,
  type Session,
  type SessionLog,
} from "../../shared/session";

const client = hc<AppType>("/api");

export interface PromptResult {
  stopReason: string;
}

export async function fetchAgentTemplates(): Promise<AgentTemplate[]> {
  const res = await client["agent-templates"].$get();
  if (!res.ok) throw new Error("Failed to fetch agent templates");
  return res.json();
}

export async function registerAgentTemplate(
  body: RegisterAgentTemplateBody,
): Promise<AgentTemplate> {
  const res = await client["agent-templates"].$post({ json: body });
  if (!res.ok) throw new Error("Failed to register agent template");
  return res.json();
}

export async function fetchSessions(): Promise<Session[]> {
  const res = await client.agents.$get();
  if (!res.ok) throw new Error("Failed to fetch sessions");
  return res.json();
}

export async function fetchSession(
  id: string,
  opts: { includeFileSystem?: boolean; showAllFiles?: boolean } = {},
): Promise<Session> {
  // Managed agents currently map 1:1 to a single session, so the UI still consumes a session
  // snapshot while the public route shape moves to /agents.
  const res = await client.agents[":agentId"].$get({
    param: { agentId: id },
    query: {
      ...(opts.includeFileSystem ? { includeFileSystem: "true" } : {}),
      ...(opts.showAllFiles ? { showAllFiles: "true" } : {}),
    },
  });
  if (!res.ok) throw new Error("Session not found");
  return res.json();
}

export async function fetchFilePreview(id: string, path: string): Promise<FilePreview> {
  const res = await client.agents[":agentId"].file.$get({
    param: { agentId: id },
    query: { path },
  });
  if (!res.ok) throw new Error("Failed to fetch file preview");
  return res.json();
}

export async function createSession(body: CreateSessionBody): Promise<Session> {
  const res = await client.agents.$post({ json: body });
  if (!res.ok) throw new Error("Failed to create session");
  return res.json();
}

export async function sendPrompt(
  id: string,
  text: string,
): Promise<PromptResult | QueuedPromptResponse> {
  const res = await client.agents[":agentId"].prompt.$post({
    param: { agentId: id },
    json: { text },
  });
  if (!res.ok) throw new Error("Failed to send prompt");
  return res.json();
}

export async function terminateSession(id: string): Promise<void> {
  const res = await client.agents[":agentId"].$delete({ param: { agentId: id } });
  if (!res.ok) throw new Error("Failed to terminate session");
}

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  body: PermissionResponseBody,
): Promise<void> {
  const res = await client.agents[":agentId"].permissions[":requestId"].$post({
    param: { agentId: sessionId, requestId },
    json: body,
  });
  if (!res.ok) throw new Error("Failed to respond to permission");
}

export function subscribeToSessionEvents(
  sessionId: string,
  onEvent: (event: SessionLog) => void,
  onError?: (error: Event) => void,
): () => void {
  const eventSource = new EventSource(`/api/agents/${encodeURIComponent(sessionId)}/events`);

  eventSource.onmessage = (e) => {
    try {
      const result = SessionLogSchema.safeParse(JSON.parse(e.data));
      if (result.success) {
        onEvent(result.data);
      }
    } catch {
      // Skip malformed events
    }
  };

  if (onError) {
    eventSource.onerror = onError;
  }

  return () => {
    eventSource.close();
  };
}
