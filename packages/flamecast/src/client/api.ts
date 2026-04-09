import { hc } from "hono/client";
import { z } from "zod";
import type { AppType } from "../flamecast/api.js";
import {
  AgentTemplateSchema,
  FilePreviewSchema,
  FileSystemSnapshotSchema,
  PromptQueueStateSchema,
  SessionSchema,
} from "../shared/session.js";
import type { RuntimeInfo, RuntimeInstance } from "@flamecast/protocol/runtime";
import type {
  AgentTemplate,
  CreateSessionBody,
  FilePreview,
  FileSystemSnapshot,
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

export type GitBranch = {
  name: string;
  sha: string;
  current: boolean;
  remote: boolean;
};

export type GitBranchesResponse = {
  branches: GitBranch[];
};

export type GitWorktree = {
  path: string;
  sha?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
};

export type GitWorktreesResponse = {
  worktrees: GitWorktree[];
};

export type GitWorktreeCreateResponse = {
  path: string;
  message: string;
};

export type UpdateAgentTemplateBody = {
  name?: string;
  spawn?: AgentTemplate["spawn"];
  runtime?: Partial<AgentTemplate["runtime"]>;
  env?: Record<string, string>;
};

export type FlamecastSettings = {
  autoApprovePermissions: boolean;
};

export type SessionSettings = {
  autoApprovePermissions: boolean;
};

const FlamecastSettingsSchema = z.object({
  autoApprovePermissions: z.boolean(),
});

const SessionSettingsSchema = z.object({
  autoApprovePermissions: z.boolean(),
});

export type FlamecastClient = {
  rpc: FlamecastRpcClient;

  // Settings
  fetchSettings(): Promise<FlamecastSettings>;
  updateSettings(patch: Partial<FlamecastSettings>): Promise<FlamecastSettings>;

  // Agent templates
  fetchAgentTemplates(): Promise<AgentTemplate[]>;
  registerAgentTemplate(body: RegisterAgentTemplateBody): Promise<AgentTemplate>;
  updateAgentTemplate(id: string, body: UpdateAgentTemplateBody): Promise<AgentTemplate>;

  // Sessions
  fetchSessions(): Promise<Session[]>;
  fetchSession(
    id: string,
    opts?: { includeFileSystem?: boolean; showAllFiles?: boolean },
  ): Promise<Session>;
  fetchSessionFilePreview(id: string, path: string): Promise<FilePreview>;
  fetchSessionFileSystem(
    id: string,
    opts?: { showAllFiles?: boolean; path?: string },
  ): Promise<FileSystemSnapshot>;
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

  // Per-session settings
  fetchSessionSettings(id: string): Promise<SessionSettings>;
  updateSessionSettings(id: string, patch: Partial<SessionSettings>): Promise<SessionSettings>;

  // Queue management
  fetchQueue(id: string): Promise<PromptQueueState>;
  cancelQueueItem(id: string, queueId: string): Promise<void>;
  clearQueue(id: string): Promise<void>;
  reorderQueue(id: string, order: string[]): Promise<void>;
  pauseQueue(id: string): Promise<void>;
  resumeQueue(id: string): Promise<void>;

  // Runtimes
  fetchRuntimes(): Promise<RuntimeInfo[]>;
  fetchRuntimeFilePreview(instanceName: string, path: string): Promise<FilePreview>;
  fetchRuntimeFileSystem(
    instanceName: string,
    opts?: { showAllFiles?: boolean; path?: string },
  ): Promise<FileSystemSnapshot>;
  startRuntime(typeName: string, name?: string): Promise<RuntimeInstance>;
  stopRuntime(instanceName: string): Promise<void>;
  pauseRuntime(instanceName: string): Promise<void>;

  // Git operations
  fetchRuntimeGitBranches(
    instanceName: string,
    opts?: { path?: string },
  ): Promise<GitBranchesResponse>;
  fetchRuntimeGitWorktrees(
    instanceName: string,
    opts?: { path?: string },
  ): Promise<GitWorktreesResponse>;
  createRuntimeGitWorktree(
    instanceName: string,
    body: {
      name: string;
      path?: string;
      branch?: string;
      newBranch?: boolean;
      startPoint?: string;
    },
  ): Promise<GitWorktreeCreateResponse>;
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

    // -- Settings --

    async fetchSettings() {
      const response = await rpc.settings.$get();
      return parseOkJson(response, FlamecastSettingsSchema, "Failed to fetch settings");
    },
    async updateSettings(patch) {
      const response = await rpc.settings.$patch({ json: patch });
      return parseOkJson(response, FlamecastSettingsSchema, "Failed to update settings");
    },

    // -- Agent templates --

    async fetchAgentTemplates() {
      const response = await rpc["agent-templates"].$get();
      return parseOkJson(response, z.array(AgentTemplateSchema), "Failed to fetch agent templates");
    },
    async registerAgentTemplate(body) {
      const response = await rpc["agent-templates"].$post({ json: body });
      return parseOkJson(response, AgentTemplateSchema, "Failed to register agent template");
    },
    async updateAgentTemplate(id, body) {
      const response = await rpc["agent-templates"][":id"].$put({
        param: { id },
        json: body,
      });
      return parseOkJson(response, AgentTemplateSchema, "Failed to update agent template");
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
    async fetchSessionFilePreview(id, path) {
      const response = await rpc.agents[":agentId"].files.$get({
        param: { agentId: id },
        query: { path },
      });
      return parseOkJson(response, FilePreviewSchema, "Failed to fetch file preview");
    },
    async fetchSessionFileSystem(id, opts = {}) {
      const response = await rpc.agents[":agentId"].fs.snapshot.$get({
        param: { agentId: id },
        query: {
          showAllFiles: opts.showAllFiles ? "true" : undefined,
          path: opts.path ?? undefined,
        },
      });
      return parseOkJson(response, FileSystemSnapshotSchema, "Failed to fetch filesystem");
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

    // -- Per-session settings --

    async fetchSessionSettings(id) {
      const response = await rpc.agents[":agentId"].settings.$get({
        param: { agentId: id },
      });
      return parseOkJson(response, SessionSettingsSchema, "Failed to fetch session settings");
    },
    async updateSessionSettings(id, patch) {
      const response = await rpc.agents[":agentId"].settings.$patch({
        param: { agentId: id },
        json: patch,
      });
      return parseOkJson(response, SessionSettingsSchema, "Failed to update session settings");
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
    async fetchRuntimeFilePreview(instanceName, path) {
      const response = await rpc.runtimes[":instanceName"].files.$get({
        param: { instanceName },
        query: { path },
      });
      return parseOkJson(response, FilePreviewSchema, "Failed to fetch runtime file preview");
    },
    async fetchRuntimeFileSystem(instanceName, opts = {}) {
      const response = await rpc.runtimes[":instanceName"].fs.snapshot.$get({
        param: { instanceName },
        query: {
          showAllFiles: opts.showAllFiles ? "true" : undefined,
          path: opts.path ?? undefined,
        },
      });
      return parseOkJson(response, FileSystemSnapshotSchema, "Failed to fetch runtime filesystem");
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
    async deleteRuntime(instanceName) {
      const response = await rpc.runtimes[":instanceName"].$delete({
        param: { instanceName },
      });
      await assertOk(response, "Failed to delete runtime");
    },
    async pauseRuntime(instanceName) {
      const response = await rpc.runtimes[":instanceName"].pause.$post({
        param: { instanceName },
      });
      await assertOk(response, "Failed to pause runtime");
    },

    // -- Git operations --

    async fetchRuntimeGitBranches(instanceName, opts = {}) {
      const response = await rpc.runtimes[":instanceName"].fs.git.branches.$get({
        param: { instanceName },
        query: { path: opts.path ?? undefined },
      });
      await assertOk(response, "Failed to fetch git branches");
      const data: GitBranchesResponse = await response.json();
      return data;
    },
    async fetchRuntimeGitWorktrees(instanceName, opts = {}) {
      const response = await rpc.runtimes[":instanceName"].fs.git.worktrees.$get({
        param: { instanceName },
        query: { path: opts.path ?? undefined },
      });
      await assertOk(response, "Failed to fetch git worktrees");
      const data: GitWorktreesResponse = await response.json();
      return data;
    },
    async createRuntimeGitWorktree(instanceName, body) {
      const response = await rpc.runtimes[":instanceName"].fs.git.worktrees.$post({
        param: { instanceName },
        json: body,
      });
      await assertOk(response, "Failed to create git worktree");
      const data: GitWorktreeCreateResponse = await response.json();
      return data;
    },
  };
}
