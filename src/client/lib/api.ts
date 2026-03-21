import type {
  Agent,
  AgentTemplate,
  CreateAgentBody,
  FilePreview,
  RegisterAgentTemplateBody,
  Session,
} from "../../shared/session";
import {
  AgentSchema,
  AgentTemplateSchema,
  FilePreviewSchema,
  SessionSchema,
} from "../../shared/session";

function isErrorPayload(value: unknown): value is { error?: string } {
  return typeof value === "object" && value !== null;
}

async function readJsonOrThrow<T>(
  response: Response,
  fallback: string,
  parse: (value: unknown) => T,
): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error =
      isErrorPayload(payload) && typeof payload.error === "string" ? payload.error : null;
    throw new Error(error ?? fallback);
  }

  return parse(await response.json());
}

export async function fetchAgentTemplates(): Promise<AgentTemplate[]> {
  const response = await fetch("/api/agent-templates");
  return readJsonOrThrow(response, "Failed to fetch agent templates", (value) =>
    AgentTemplateSchema.array().parse(value),
  );
}

export async function registerAgentTemplate(
  body: RegisterAgentTemplateBody,
): Promise<AgentTemplate> {
  const response = await fetch("/api/agent-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow(response, "Failed to register agent template", (value) =>
    AgentTemplateSchema.parse(value),
  );
}

export async function fetchSessions(): Promise<Session[]> {
  const response = await fetch("/api/sessions");
  return readJsonOrThrow(response, "Failed to fetch sessions", (value) =>
    SessionSchema.array().parse(value),
  );
}

export async function fetchAgents(): Promise<Agent[]> {
  const response = await fetch("/api/agents");
  return readJsonOrThrow(response, "Failed to fetch agents", (value) =>
    AgentSchema.array().parse(value),
  );
}

export async function fetchAgent(agentId: string): Promise<Agent> {
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`);
  return readJsonOrThrow(response, "Agent not found", (value) => AgentSchema.parse(value));
}

export async function createAgent(body: CreateAgentBody): Promise<Agent> {
  const response = await fetch("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow(response, "Failed to create agent", (value) => AgentSchema.parse(value));
}

export async function fetchSession(
  agentId: string,
  sessionId: string,
  opts: { includeFileSystem?: boolean; showAllFiles?: boolean } = {},
): Promise<Session> {
  const query = new URLSearchParams();
  if (opts.includeFileSystem) query.set("includeFileSystem", "true");
  if (opts.showAllFiles) query.set("showAllFiles", "true");
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}${suffix}`,
  );
  return readJsonOrThrow(response, "Session not found", (value) => SessionSchema.parse(value));
}

export async function fetchFilePreview(
  agentId: string,
  sessionId: string,
  path: string,
): Promise<FilePreview> {
  const query = new URLSearchParams({ path });
  const response = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/file?${query.toString()}`,
  );
  return readJsonOrThrow(response, "Failed to fetch file preview", (value) =>
    FilePreviewSchema.parse(value),
  );
}

export async function terminateAgent(agentId: string): Promise<void> {
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
  await readJsonOrThrow(response, "Failed to terminate agent", (value) => value);
}
