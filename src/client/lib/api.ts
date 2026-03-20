import { hc } from "hono/client";
import type { AppType } from "@/flamecast/index";
import type {
  ConnectionInfo,
  CreateConnectionBody,
  AgentProcessInfo,
  RegisterAgentProcessBody,
  PermissionResponseBody,
} from "../../shared/connection";

const client = hc<AppType>("/api");

export interface PromptResult {
  stopReason: string;
}

export async function fetchAgentProcesses(): Promise<AgentProcessInfo[]> {
  const res = await client["agent-processes"].$get();
  if (!res.ok) throw new Error("Failed to fetch agent processes");
  return res.json();
}

export async function registerAgentProcess(
  body: RegisterAgentProcessBody,
): Promise<AgentProcessInfo> {
  const res = await client["agent-processes"].$post({ json: body });
  if (!res.ok) throw new Error("Failed to register agent process");
  return res.json();
}

export async function fetchConnections(): Promise<ConnectionInfo[]> {
  const res = await client.connections.$get();
  if (!res.ok) throw new Error("Failed to fetch connections");
  return res.json();
}

export async function fetchConnection(id: string): Promise<ConnectionInfo> {
  const res = await client.connections[":id"].$get({ param: { id } });
  if (!res.ok) throw new Error("Connection not found");
  return res.json();
}

export async function createConnection(body: CreateConnectionBody): Promise<ConnectionInfo> {
  const res = await client.connections.$post({ json: body });
  if (!res.ok) throw new Error("Failed to create connection");
  return res.json();
}

export async function sendPrompt(id: string, text: string): Promise<PromptResult> {
  const res = await client.connections[":id"].prompt.$post({
    param: { id },
    json: { text },
  });
  if (!res.ok) throw new Error("Failed to send prompt");
  return res.json();
}

export async function killConnection(id: string): Promise<void> {
  const res = await client.connections[":id"].$delete({ param: { id } });
  if (!res.ok) throw new Error("Failed to kill connection");
}

export async function respondToPermission(
  connectionId: string,
  requestId: string,
  body: PermissionResponseBody,
): Promise<void> {
  const res = await client.connections[":id"].permissions[":requestId"].$post({
    param: { id: connectionId, requestId },
    json: body,
  });
  if (!res.ok) throw new Error("Failed to respond to permission");
}
