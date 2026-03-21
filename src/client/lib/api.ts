import { hc } from "hono/client";
import type { AppType } from "../../flamecast/api";
import type {
  Agent,
  CreateAgentBody,
  FilePreview,
  FileSystemSnapshot,
  Session,
  SessionSummary,
} from "../../shared/session";
import {
  AgentSchema,
  FilePreviewSchema,
  FileSystemSnapshotSchema,
  SessionSchema,
  SessionSummarySchema,
} from "../../shared/session";

const client = hc<AppType>("/api");

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

export async function fetchSessions(): Promise<SessionSummary[]> {
  const response = await client.sessions.$get();
  return readJsonOrThrow(response, "Failed to fetch sessions", (value) =>
    SessionSummarySchema.array().parse(value),
  );
}

export async function createAgent(body: CreateAgentBody): Promise<Agent> {
  const response = await client.agents.$post({
    json: body,
  });
  return readJsonOrThrow(response, "Failed to create agent", (value) => AgentSchema.parse(value));
}

export async function fetchSession(
  agentId: string,
  sessionId: string,
  opts: { includeFileSystem?: boolean; showAllFiles?: boolean } = {},
): Promise<Session> {
  const query: { includeFileSystem?: "true"; showAllFiles?: "true" } = {
    ...(opts.includeFileSystem ? { includeFileSystem: "true" } : {}),
    ...(opts.showAllFiles ? { showAllFiles: "true" } : {}),
  };

  const response = await client.agents[":agentId"].sessions[":sessionId"].$get({
    param: { agentId, sessionId },
    query,
  });
  return readJsonOrThrow(response, "Session not found", (value) => SessionSchema.parse(value));
}

export async function fetchSessionFileSystem(
  agentId: string,
  sessionId: string,
  opts: { showAllFiles?: boolean } = {},
): Promise<FileSystemSnapshot> {
  const response = await client.agents[":agentId"].sessions[":sessionId"].filesystem.$get({
    param: { agentId, sessionId },
    query: {
      ...(opts.showAllFiles ? { showAllFiles: "true" } : {}),
    },
  });
  return readJsonOrThrow(response, "Failed to fetch filesystem", (value) =>
    FileSystemSnapshotSchema.parse(value),
  );
}

export async function fetchFilePreview(
  agentId: string,
  sessionId: string,
  path: string,
): Promise<FilePreview> {
  const response = await client.agents[":agentId"].sessions[":sessionId"].file.$get({
    param: { agentId, sessionId },
    query: { path },
  });
  return readJsonOrThrow(response, "Failed to fetch file preview", (value) =>
    FilePreviewSchema.parse(value),
  );
}

export async function terminateAgent(agentId: string): Promise<void> {
  const response = await client.agents[":agentId"].$delete({
    param: { agentId },
  });
  await readJsonOrThrow(response, "Failed to terminate agent", (value) => value);
}
