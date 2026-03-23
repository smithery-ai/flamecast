import { hc } from "hono/client";
import { z } from "zod";
import type { AppType } from "../flamecast/api.js";
import { AgentTemplateSchema, SessionSchema } from "../shared/session.js";
import type {
  AgentTemplate,
  CreateSessionBody,
  RegisterAgentTemplateBody,
  Session,
} from "../shared/session.js";

export type FlamecastClientOptions = {
  baseUrl: string | URL;
  fetch?: typeof fetch;
};

function normalizeBaseUrl(baseUrl: string | URL): string {
  return typeof baseUrl === "string" ? baseUrl : baseUrl.toString();
}

export function createFlamecastRpcClient(options: FlamecastClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  return options.fetch ? hc<AppType>(baseUrl, { fetch: options.fetch }) : hc<AppType>(baseUrl);
}

export type FlamecastRpcClient = ReturnType<typeof createFlamecastRpcClient>;

export type FlamecastClient = {
  rpc: FlamecastRpcClient;
  fetchAgentTemplates(): Promise<AgentTemplate[]>;
  registerAgentTemplate(body: RegisterAgentTemplateBody): Promise<AgentTemplate>;
  fetchSessions(): Promise<Session[]>;
  fetchSession(
    id: string,
    opts?: { includeFileSystem?: boolean; showAllFiles?: boolean },
  ): Promise<Session>;
  createSession(body: CreateSessionBody): Promise<Session>;
  terminateSession(id: string): Promise<void>;
};

async function assertOk(response: Response, message: string): Promise<void> {
  if (!response.ok) {
    throw new Error(message);
  }
}

async function parseOkJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  message: string,
): Promise<T> {
  await assertOk(response, message);
  return schema.parse(await response.json());
}

export function createFlamecastClient(options: FlamecastClientOptions): FlamecastClient {
  const rpc = createFlamecastRpcClient(options);

  return {
    rpc,
    async fetchAgentTemplates() {
      const response = await rpc["agent-templates"].$get();
      return parseOkJson(response, z.array(AgentTemplateSchema), "Failed to fetch agent templates");
    },
    async registerAgentTemplate(body) {
      const response = await rpc["agent-templates"].$post({ json: body });
      return parseOkJson(response, AgentTemplateSchema, "Failed to register agent template");
    },
    async fetchSessions() {
      const response = await rpc.agents.$get();
      return parseOkJson(response, z.array(SessionSchema), "Failed to fetch sessions");
    },
    async fetchSession(id, opts = {}) {
      const response = await rpc.agents[":agentId"].$get({
        param: { agentId: id },
        query: {
          includeFileSystem: opts.includeFileSystem ? "true" : undefined,
          showAllFiles: opts.showAllFiles ? "true" : undefined,
        },
      });
      return parseOkJson(response, SessionSchema, "Session not found");
    },
    async createSession(body) {
      const response = await rpc.agents.$post({ json: body });
      return parseOkJson(response, SessionSchema, "Failed to create session");
    },
    async terminateSession(id) {
      const response = await rpc.agents[":agentId"].$delete({ param: { agentId: id } });
      await assertOk(response, "Failed to terminate session");
    },
  };
}
