import { hc } from "hono/client";
import type { AppType } from "@/flamecast/api";
import type {
  AgentTemplate,
  CreateSessionBody,
  PermissionResponseBody,
  RegisterAgentTemplateBody,
  Session,
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
  const res = await client.sessions.$get();
  if (!res.ok) throw new Error("Failed to fetch sessions");
  return res.json();
}

export async function fetchSession(id: string): Promise<Session> {
  const res = await client.sessions[":id"].$get({ param: { id } });
  if (!res.ok) throw new Error("Session not found");
  return res.json();
}

export async function createSession(body: CreateSessionBody): Promise<Session> {
  const res = await client.sessions.$post({ json: body });
  if (!res.ok) throw new Error("Failed to create session");
  return res.json();
}

export async function sendPrompt(id: string, text: string): Promise<PromptResult> {
  const res = await client.sessions[":id"].prompt.$post({
    param: { id },
    json: { text },
  });
  if (!res.ok) throw new Error("Failed to send prompt");
  return res.json();
}

export async function terminateSession(id: string): Promise<void> {
  const res = await client.sessions[":id"].$delete({ param: { id } });
  if (!res.ok) throw new Error("Failed to terminate session");
}

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  body: PermissionResponseBody,
): Promise<void> {
  const res = await client.sessions[":id"].permissions[":requestId"].$post({
    param: { id: sessionId, requestId },
    json: body,
  });
  if (!res.ok) throw new Error("Failed to respond to permission");
}
