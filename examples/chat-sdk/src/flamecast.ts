import { createFlamecastClient, type FlamecastClientOptions } from "@flamecast/sdk/client";
import type {
  CreateSessionBody,
  McpServer,
  PromptResult,
  QueuedPromptResponse,
  Session,
} from "@flamecast/sdk/shared/session";

export type FlamecastSpawn = {
  command: string;
  args?: string[];
};
export type FlamecastCreateAgentBody = Omit<CreateSessionBody, "spawn"> & {
  spawn?: FlamecastSpawn;
};
export type FlamecastAgent = Pick<Session, "id">;
export type FlamecastPromptResult = PromptResult | QueuedPromptResponse;

export type FlamecastAgentClient = {
  createAgent(body: FlamecastCreateAgentBody): Promise<FlamecastAgent>;
  promptAgent(agentId: string, text: string): Promise<FlamecastPromptResult>;
  terminateAgent(agentId: string): Promise<void>;
};

export function createFlamecastAgentClient(options: FlamecastClientOptions): FlamecastAgentClient {
  const client = createFlamecastClient({
    ...options,
    baseUrl: resolveFlamecastApiBaseUrl(options.baseUrl),
  });

  return {
    async createAgent(body) {
      const session = await client.createSession(toCreateSessionBody(body));
      return { id: session.id };
    },
    promptAgent(agentId, text) {
      return client.sendPrompt(agentId, text);
    },
    terminateAgent(agentId) {
      return client.terminateSession(agentId);
    },
  };
}

function toCreateSessionBody(body: FlamecastCreateAgentBody): CreateSessionBody {
  const { spawn, ...rest } = body;

  if (!spawn) {
    return rest;
  }

  return {
    ...rest,
    spawn: {
      command: spawn.command,
      args: spawn.args ?? [],
    },
  };
}

function resolveFlamecastApiBaseUrl(baseUrl: string | URL): string {
  const url = new URL(baseUrl);

  if (url.pathname.endsWith("/api")) {
    return url.toString();
  }

  if (url.pathname.endsWith("/api/")) {
    url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  }

  url.pathname = `${url.pathname.replace(/\/?$/u, "/")}api`;
  return url.toString();
}

export function createConnectorMcpServer(
  endpoint: string | URL,
  authToken: string,
  options: { headerName?: string; serverName?: string } = {},
): McpServer {
  return {
    type: "http",
    name: options.serverName ?? "chat-sdk",
    url: new URL(endpoint).toString(),
    headers: [
      {
        name: options.headerName ?? "x-flamecast-chat-token",
        value: authToken,
      },
    ],
  };
}
