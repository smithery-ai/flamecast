import { hc } from "hono/client";
import { z } from "zod";
import type { AppType } from "../flamecast/api.js";
import { AgentTemplateSchema, PromptQueueStateSchema, SessionSchema } from "../shared/session.js";
import type { RuntimeInfo, RuntimeInstance } from "@flamecast/protocol/runtime";
import type {
  AgentTemplate,
  CreateSessionBody,
  PromptQueueState,
  QueuedPromptResponse,
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

/** Prompt result — either immediate execution or queued. */
export type PromptResult = Record<string, unknown> | QueuedPromptResponse;

export type FlamecastClient = {
  rpc: FlamecastRpcClient;

  // Agent templates
  fetchAgentTemplates(): Promise<AgentTemplate[]>;
  registerAgentTemplate(body: RegisterAgentTemplateBody): Promise<AgentTemplate>;

  // Sessions
  fetchSessions(): Promise<Session[]>;
  fetchSession(
    id: string,
    opts?: { includeFileSystem?: boolean; showAllFiles?: boolean },
  ): Promise<Session>;
  createSession(body: CreateSessionBody): Promise<Session>;
  terminateSession(id: string): Promise<void>;

  // Prompts
  promptSession(id: string, text: string): Promise<PromptResult>;

  // Permissions
  resolvePermission(
    sessionId: string,
    requestId: string,
    body: { optionId: string } | { outcome: "cancelled" },
  ): Promise<Record<string, unknown>>;

  // Queue management
  fetchQueue(id: string): Promise<PromptQueueState>;
  cancelQueueItem(id: string, queueId: string): Promise<void>;
  clearQueue(id: string): Promise<void>;
  reorderQueue(id: string, order: string[]): Promise<void>;
  pauseQueue(id: string): Promise<void>;
  resumeQueue(id: string): Promise<void>;

  // Runtimes
  fetchRuntimes(): Promise<RuntimeInfo[]>;
  startRuntime(typeName: string, name?: string): Promise<RuntimeInstance>;
  stopRuntime(instanceName: string): Promise<void>;
  pauseRuntime(instanceName: string): Promise<void>;
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

    // -- Agent templates --

    async fetchAgentTemplates() {
      const response = await rpc["agent-templates"].$get();
      return parseOkJson(response, z.array(AgentTemplateSchema), "Failed to fetch agent templates");
    },
    async registerAgentTemplate(body) {
      const response = await rpc["agent-templates"].$post({ json: body });
      return parseOkJson(response, AgentTemplateSchema, "Failed to register agent template");
    },

    // -- Sessions --

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

    // -- Prompts --

    async promptSession(id, text) {
      const response = await rpc.agents[":agentId"].prompts.$post({
        param: { agentId: id },
        json: { text },
      });
      if (!response.ok) {
        throw new Error(`Prompt failed (${response.status})`);
      }
      return response.json();
    },

    // -- Permissions --

    async resolvePermission(sessionId, requestId, body) {
      const response = await rpc.agents[":agentId"].permissions[":requestId"].$post({
        param: { agentId: sessionId, requestId },
        json: body,
      });
      if (!response.ok) {
        throw new Error(`Permission resolve failed (${response.status})`);
      }
      return response.json();
    },

    // -- Queue management --

    async fetchQueue(id) {
      const response = await rpc.agents[":agentId"].queue.$get({
        param: { agentId: id },
      });
      return parseOkJson(response, PromptQueueStateSchema, "Failed to fetch queue");
    },
    async cancelQueueItem(id, queueId) {
      const response = await rpc.agents[":agentId"].queue[":queueId"].$delete({
        param: { agentId: id, queueId },
      });
      await assertOk(response, "Failed to cancel queue item");
    },
    async clearQueue(id) {
      const response = await rpc.agents[":agentId"].queue.$delete({
        param: { agentId: id },
      });
      await assertOk(response, "Failed to clear queue");
    },
    async reorderQueue(id, order) {
      const response = await rpc.agents[":agentId"].queue.$put({
        param: { agentId: id },
        json: { order },
      });
      await assertOk(response, "Failed to reorder queue");
    },
    async pauseQueue(id) {
      const response = await rpc.agents[":agentId"].queue.pause.$post({
        param: { agentId: id },
      });
      await assertOk(response, "Failed to pause queue");
    },
    async resumeQueue(id) {
      const response = await rpc.agents[":agentId"].queue.resume.$post({
        param: { agentId: id },
      });
      await assertOk(response, "Failed to resume queue");
    },

    // -- Runtimes --

    async fetchRuntimes() {
      const response = await rpc.runtimes.$get();
      await assertOk(response, "Failed to fetch runtimes");
      const data: RuntimeInfo[] = await response.json();
      return data;
    },
    async startRuntime(typeName, name?) {
      const response = await rpc.runtimes[":typeName"].start.$post({
        param: { typeName },
        json: name ? { name } : {},
      });
      await assertOk(response, "Failed to start runtime");
      const data: RuntimeInstance = await response.json();
      return data;
    },
    async stopRuntime(instanceName) {
      const response = await rpc.runtimes[":instanceName"].stop.$post({
        param: { instanceName },
      });
      await assertOk(response, "Failed to stop runtime");
    },
    async pauseRuntime(instanceName) {
      const response = await rpc.runtimes[":instanceName"].pause.$post({
        param: { instanceName },
      });
      await assertOk(response, "Failed to pause runtime");
    },
  };
}
