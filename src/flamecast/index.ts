import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { serve } from "@hono/node-server";
import type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  CreateSessionBody,
  PendingPermission,
  PendingPermissionOption,
  PermissionResponseBody,
  RegisterAgentTemplateBody,
  Session,
  SessionLog,
} from "../shared/session.js";
import { createServerApp } from "../server/app.js";
import { getBuiltinAgentTemplates, localRuntime } from "./agent-templates.js";
import type { FlamecastStorage, StorageConfig } from "./storage.js";
import { resolveStorage } from "./storage.js";
import type { RuntimeProviderRegistry, StartedRuntime } from "./runtime-provider.js";
import { resolveRuntimeProviders } from "./runtime-provider.js";
import type { AcpTransport } from "./transport.js";

export type { AgentSpawn, AgentTemplate, PendingPermission, Session } from "../shared/session.js";
export type { SessionMeta, FlamecastStorage, StorageConfig } from "./storage.js";
export type { RuntimeProvider, RuntimeProviderRegistry } from "./runtime-provider.js";
export type { AppType } from "./api.js";
export type { AcpTransport } from "./transport.js";

type PermissionResolver = (response: acp.RequestPermissionResponse) => void | Promise<void>;

type StreamingTextChunkKind = "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk";

interface SessionTextChunkLogBuffer {
  sessionId: string;
  kind: StreamingTextChunkKind;
  messageId: string | null;
  texts: string[];
}

interface ManagedSession {
  id: string;
  transport: AcpTransport;
  terminate: () => Promise<void>;
  runtime: {
    connection: acp.ClientSideConnection | null;
    sessionTextChunkLogBuffer: SessionTextChunkLogBuffer | null;
  };
}

export type FlamecastOptions = {
  storage?: StorageConfig;
  runtimeProviders?: RuntimeProviderRegistry;
  agentTemplates?: AgentTemplate[];
};

export class Flamecast {
  private readonly initialAgentTemplates: AgentTemplate[];
  private readonly runtimeProviders: RuntimeProviderRegistry;
  private readonly storageConfig?: StorageConfig;
  private readonly runtimes = new Map<string, ManagedSession>();
  private readonly permissionResolvers = new Map<string, PermissionResolver>();
  private readonly app = createServerApp(this);
  private storage: FlamecastStorage | null = null;
  private readyPromise: Promise<void> | null = null;

  readonly fetch: (request: Request) => Promise<Response>;

  constructor(opts: FlamecastOptions = {}) {
    this.storageConfig = opts.storage;
    this.runtimeProviders = resolveRuntimeProviders(opts.runtimeProviders);
    this.initialAgentTemplates = opts.agentTemplates ?? getBuiltinAgentTemplates();
    this.fetch = async (request: Request) => this.app.fetch(request);
  }

  async listen(port = 3001) {
    await this.ensureReady();
    return serve({ fetch: this.fetch, port }, (info) => {
      console.log(`Flamecast running on http://localhost:${info.port}`);
    });
  }

  async shutdown(): Promise<void> {
    for (const session of await this.listSessions()) {
      await this.terminateSession(session.id).catch(() => {});
    }
  }

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    await this.ensureReady();
    return this.requireStorage().listAgentTemplates();
  }

  async registerAgentTemplate(body: RegisterAgentTemplateBody): Promise<AgentTemplate> {
    await this.ensureReady();

    const template: AgentTemplate = {
      id: randomUUID(),
      name: body.name,
      spawn: {
        command: body.spawn.command,
        args: [...body.spawn.args],
      },
      runtime: body.runtime ? { ...body.runtime } : localRuntime(),
    };

    await this.requireStorage().saveAgentTemplate(template);
    return template;
  }

  async createSession(opts: CreateSessionBody): Promise<Session> {
    await this.ensureReady();

    const cwd = opts.cwd ?? process.cwd();
    const { agentName, spawn, runtime } = await this.resolveSessionDefinition(opts);
    const provider = this.runtimeProviders[runtime.provider];

    if (!provider) {
      throw new Error(`Unknown runtime provider "${runtime.provider}"`);
    }

    const startedAt = new Date().toISOString();
    const startedRuntime = await provider.start({ runtime, spawn });
    const startupLogs: SessionLog[] = [];
    const managed: ManagedSession = {
      id: "",
      transport: startedRuntime.transport,
      terminate: startedRuntime.terminate,
      runtime: {
        connection: null,
        sessionTextChunkLogBuffer: null,
      },
    };

    const stream = acp.ndJsonStream(
      startedRuntime.transport.input,
      startedRuntime.transport.output,
    );
    const client = this.createClient(managed);
    const connection = new acp.ClientSideConnection((_agent) => client, stream);
    managed.runtime.connection = connection;

    try {
      const initParams: acp.InitializeRequest = {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      };

      startupLogs.push(
        this.createRpcLog(acp.AGENT_METHODS.initialize, "client_to_agent", "request", initParams),
      );
      const initResult = await connection.initialize(initParams);
      startupLogs.push(
        this.createRpcLog(acp.AGENT_METHODS.initialize, "agent_to_client", "response", initResult),
      );

      const newSessionParams: acp.NewSessionRequest = { cwd, mcpServers: [] };
      startupLogs.push(
        this.createRpcLog(
          acp.AGENT_METHODS.session_new,
          "client_to_agent",
          "request",
          newSessionParams,
        ),
      );
      const sessionResult = await connection.newSession(newSessionParams);
      startupLogs.push(
        this.createRpcLog(
          acp.AGENT_METHODS.session_new,
          "agent_to_client",
          "response",
          sessionResult,
        ),
      );

      managed.id = sessionResult.sessionId;
      const storage = this.requireStorage();
      const now = new Date().toISOString();

      await storage.createSession({
        id: managed.id,
        agentName,
        spawn,
        startedAt,
        lastUpdatedAt: now,
        pendingPermission: null,
      });

      for (const log of startupLogs) {
        await storage.appendLog(managed.id, log);
      }

      this.runtimes.set(managed.id, managed);
      return this.snapshotSession(managed.id);
    } catch (error) {
      await this.stopRuntime(startedRuntime);
      throw error;
    }
  }

  async listSessions(): Promise<Session[]> {
    await this.ensureReady();
    const ids = [...this.runtimes.keys()];
    return Promise.all(ids.map((id) => this.snapshotSession(id)));
  }

  async getSession(id: string): Promise<Session> {
    await this.ensureReady();
    this.resolveRuntime(id);
    return this.snapshotSession(id);
  }

  async promptSession(id: string, text: string): Promise<acp.PromptResponse> {
    await this.ensureReady();

    const managed = this.resolveRuntime(id);
    if (!managed.runtime.connection) {
      throw new Error(`Session "${id}" is not initialized`);
    }

    const promptParams: acp.PromptRequest = {
      sessionId: managed.id,
      prompt: [{ type: "text", text }],
    };

    await this.pushRpcLog(
      managed,
      acp.AGENT_METHODS.session_prompt,
      "client_to_agent",
      "request",
      promptParams,
    );

    try {
      const result = await managed.runtime.connection.prompt(promptParams);
      await this.flushSessionTextChunkLogBuffer(managed);
      await this.pushRpcLog(
        managed,
        acp.AGENT_METHODS.session_prompt,
        "agent_to_client",
        "response",
        result,
      );
      return result;
    } catch (error) {
      await this.flushSessionTextChunkLogBuffer(managed);
      throw error;
    }
  }

  async terminateSession(id: string): Promise<void> {
    await this.ensureReady();

    const managed = this.resolveRuntime(id);
    const meta = await this.requireStorage().getSessionMeta(id);
    if (meta?.pendingPermission) {
      this.permissionResolvers.delete(meta.pendingPermission.requestId);
    }

    await this.flushSessionTextChunkLogBuffer(managed);
    await managed.terminate();
    await this.pushLog(managed, "killed", {});
    await this.requireStorage().finalizeSession(id, "terminated");
    this.runtimes.delete(id);
  }

  async respondToPermission(
    id: string,
    requestId: string,
    body: PermissionResponseBody,
  ): Promise<void> {
    await this.ensureReady();

    const managed = this.resolveRuntime(id);
    const pending = await this.takePendingPermissionResolution(managed, requestId);

    if ("outcome" in body && body.outcome === "cancelled") {
      await this.logPermissionCancelled(managed, pending);
      await Promise.resolve(pending.resolve({ outcome: { outcome: "cancelled" } }));
      return;
    }

    if (!("optionId" in body)) {
      throw new Error("Invalid permission response");
    }

    const option = this.getPermissionOption(pending, body.optionId);
    await this.logPermissionSelection(managed, pending, option);
    await Promise.resolve(
      pending.resolve({
        outcome: { outcome: "selected", optionId: option.optionId },
      }),
    );
  }

  private async ensureReady(): Promise<void> {
    if (this.storage) return;
    if (!this.readyPromise) {
      this.readyPromise = resolveStorage(this.storageConfig).then((storage) => {
        this.storage = storage;
        return storage.seedAgentTemplates(this.initialAgentTemplates);
      });
    }
    await this.readyPromise;
  }

  private requireStorage(): FlamecastStorage {
    if (!this.storage) {
      throw new Error("Flamecast storage is not ready");
    }
    return this.storage;
  }

  private async resolveSessionDefinition(opts: CreateSessionBody): Promise<{
    agentName: string;
    spawn: AgentSpawn;
    runtime: AgentTemplateRuntime;
  }> {
    if (opts.agentTemplateId) {
      const template = await this.requireStorage().getAgentTemplate(opts.agentTemplateId);
      if (!template) {
        throw new Error(`Unknown agent template "${opts.agentTemplateId}"`);
      }

      return {
        agentName: template.name,
        spawn: {
          command: template.spawn.command,
          args: [...template.spawn.args],
        },
        runtime: { ...template.runtime },
      };
    }

    if (!opts.spawn) {
      throw new Error("Provide agentTemplateId or spawn");
    }

    return {
      agentName:
        opts.name?.trim() ||
        [opts.spawn.command, ...(opts.spawn.args ?? [])].filter(Boolean).join(" "),
      spawn: {
        command: opts.spawn.command,
        args: [...(opts.spawn.args ?? [])],
      },
      runtime: localRuntime(),
    };
  }

  private resolveRuntime(id: string): ManagedSession {
    const managed = this.runtimes.get(id);
    if (!managed) {
      throw new Error(`Session "${id}" not found`);
    }
    return managed;
  }

  private async snapshotSession(id: string): Promise<Session> {
    const storage = this.requireStorage();
    const meta = await storage.getSessionMeta(id);
    if (!meta) {
      throw new Error(`Session "${id}" not found`);
    }
    const logs = await storage.getLogs(id);
    return {
      ...meta,
      logs: [...logs],
      pendingPermission: meta.pendingPermission
        ? {
            ...meta.pendingPermission,
            options: meta.pendingPermission.options.map((option) => ({ ...option })),
          }
        : null,
    };
  }

  private createLogEntry(type: string, data: Record<string, unknown>): SessionLog {
    return {
      timestamp: new Date().toISOString(),
      type,
      data,
    };
  }

  private createRpcLog(
    method: string,
    direction: "client_to_agent" | "agent_to_client",
    phase: "request" | "response" | "notification",
    payload?: unknown,
  ): SessionLog {
    const data: Record<string, unknown> = { method, direction, phase };
    if (payload !== undefined) data.payload = payload;
    return this.createLogEntry("rpc", data);
  }

  private async pushLog(
    managed: ManagedSession,
    type: string,
    data: Record<string, unknown>,
  ): Promise<SessionLog> {
    const entry = this.createLogEntry(type, data);
    const storage = this.requireStorage();
    await storage.appendLog(managed.id, entry);
    await storage.updateSession(managed.id, { lastUpdatedAt: entry.timestamp });
    return entry;
  }

  private async pushRpcLog(
    managed: ManagedSession,
    method: string,
    direction: "client_to_agent" | "agent_to_client",
    phase: "request" | "response" | "notification",
    payload?: unknown,
  ): Promise<void> {
    const entry = this.createRpcLog(method, direction, phase, payload);
    const storage = this.requireStorage();
    await storage.appendLog(managed.id, entry);
    await storage.updateSession(managed.id, { lastUpdatedAt: entry.timestamp });
  }

  private async flushSessionTextChunkLogBuffer(managed: ManagedSession): Promise<void> {
    const buffer = managed.runtime.sessionTextChunkLogBuffer;
    if (!buffer || buffer.texts.length === 0) {
      managed.runtime.sessionTextChunkLogBuffer = null;
      return;
    }

    managed.runtime.sessionTextChunkLogBuffer = null;

    let combined: string;
    try {
      combined = buffer.texts.join("");
    } catch (error) {
      await this.pushLog(managed, "rpc_coalesce_error", {
        reason: "join_failed",
        message: error instanceof Error ? error.message : String(error),
        partialParts: buffer.texts.length,
      });

      for (const text of buffer.texts) {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.session_update,
          "agent_to_client",
          "notification",
          {
            sessionId: buffer.sessionId,
            update: {
              sessionUpdate: buffer.kind,
              content: { type: "text", text },
              ...(buffer.messageId != null ? { messageId: buffer.messageId } : {}),
            },
          },
        );
      }
      return;
    }

    const update = {
      sessionUpdate: buffer.kind,
      content: { type: "text" as const, text: combined },
      ...(buffer.messageId != null ? { messageId: buffer.messageId } : {}),
    } satisfies acp.SessionUpdate;

    await this.pushRpcLog(
      managed,
      acp.CLIENT_METHODS.session_update,
      "agent_to_client",
      "notification",
      { sessionId: buffer.sessionId, update },
    );
  }

  private async logSessionUpdateNotification(
    managed: ManagedSession,
    params: acp.SessionNotification,
  ): Promise<void> {
    const update = params.update;
    if (
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "user_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk") &&
      update.content.type === "text" &&
      typeof update.content.text === "string"
    ) {
      const kind = update.sessionUpdate;
      const messageId = update.messageId ?? null;
      const buffer = managed.runtime.sessionTextChunkLogBuffer;

      if (
        buffer &&
        (buffer.sessionId !== params.sessionId ||
          buffer.kind !== kind ||
          (buffer.messageId ?? null) !== messageId)
      ) {
        await this.flushSessionTextChunkLogBuffer(managed);
      }

      const next = managed.runtime.sessionTextChunkLogBuffer;
      if (next) {
        next.texts.push(update.content.text);
      } else {
        managed.runtime.sessionTextChunkLogBuffer = {
          sessionId: params.sessionId,
          kind,
          messageId,
          texts: [update.content.text],
        };
      }
      return;
    }

    await this.flushSessionTextChunkLogBuffer(managed);
    await this.pushRpcLog(
      managed,
      acp.CLIENT_METHODS.session_update,
      "agent_to_client",
      "notification",
      params,
    );
  }

  private async takePendingPermissionResolution(
    managed: ManagedSession,
    requestId: string,
  ): Promise<{ permission: PendingPermission; resolve: PermissionResolver }> {
    const storage = this.requireStorage();
    const meta = await storage.getSessionMeta(managed.id);
    const permission = meta?.pendingPermission;
    const resolve = this.permissionResolvers.get(requestId);

    if (!permission || permission.requestId !== requestId || !resolve) {
      throw new Error("Permission request not found or already resolved");
    }

    await storage.updateSession(managed.id, { pendingPermission: null });
    this.permissionResolvers.delete(requestId);
    return { permission, resolve };
  }

  private getPermissionOption(
    pending: { permission: PendingPermission; resolve: PermissionResolver },
    optionId: string,
  ): PendingPermissionOption {
    const option = pending.permission.options.find((candidate) => candidate.optionId === optionId);
    if (!option) {
      throw new Error(`Unknown permission option "${optionId}"`);
    }
    return option;
  }

  private async logPermissionCancelled(
    managed: ManagedSession,
    pending: { permission: PendingPermission; resolve: PermissionResolver },
  ): Promise<void> {
    await this.pushLog(managed, "permission_cancelled", {
      requestId: pending.permission.requestId,
      toolCallId: pending.permission.toolCallId,
    });
  }

  private async logPermissionSelection(
    managed: ManagedSession,
    pending: { permission: PendingPermission; resolve: PermissionResolver },
    option: PendingPermissionOption,
  ): Promise<void> {
    await this.pushLog(managed, this.getPermissionLogType(option.kind), {
      requestId: pending.permission.requestId,
      toolCallId: pending.permission.toolCallId,
      optionId: option.optionId,
      optionName: option.name,
    });
  }

  private getPermissionLogType(kind: string): string {
    switch (kind) {
      case "allow_once":
        return "permission_approved";
      case "reject_once":
        return "permission_rejected";
      default:
        return "permission_responded";
    }
  }

  private createPendingPermission(params: acp.RequestPermissionRequest): PendingPermission {
    return {
      requestId: randomUUID(),
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "",
      kind: params.toolCall.kind ?? undefined,
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: String(option.kind),
      })),
    };
  }

  private createClient(managed: ManagedSession): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        await this.logSessionUpdateNotification(managed, params);
      },

      requestPermission: async (
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.session_request_permission,
          "agent_to_client",
          "request",
          params,
        );

        const pendingPermission = this.createPendingPermission(params);
        const now = new Date().toISOString();

        await this.requireStorage().updateSession(managed.id, {
          pendingPermission,
          lastUpdatedAt: now,
        });

        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          const wrapped: PermissionResolver = async (response) => {
            await this.pushRpcLog(
              managed,
              acp.CLIENT_METHODS.session_request_permission,
              "client_to_agent",
              "response",
              response,
            );
            resolve(response);
          };
          this.permissionResolvers.set(pendingPermission.requestId, wrapped);
        });
      },

      readTextFile: async (params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.fs_read_text_file,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.ReadTextFileResponse = { content: "" };
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.fs_read_text_file,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      writeTextFile: async (
        params: acp.WriteTextFileRequest,
      ): Promise<acp.WriteTextFileResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.fs_write_text_file,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.WriteTextFileResponse = {};
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.fs_write_text_file,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      createTerminal: async (
        params: acp.CreateTerminalRequest,
      ): Promise<acp.CreateTerminalResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_create,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.CreateTerminalResponse = { terminalId: `stub-${randomUUID()}` };
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_create,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      terminalOutput: async (
        params: acp.TerminalOutputRequest,
      ): Promise<acp.TerminalOutputResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_output,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.TerminalOutputResponse = { output: "", truncated: false };
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_output,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      releaseTerminal: async (
        params: acp.ReleaseTerminalRequest,
      ): Promise<acp.ReleaseTerminalResponse | void> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_release,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.ReleaseTerminalResponse = {};
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_release,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      waitForTerminalExit: async (
        params: acp.WaitForTerminalExitRequest,
      ): Promise<acp.WaitForTerminalExitResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_wait_for_exit,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.WaitForTerminalExitResponse = { exitCode: 0 };
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_wait_for_exit,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      killTerminal: async (
        params: acp.KillTerminalRequest,
      ): Promise<acp.KillTerminalResponse | void> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_kill,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.KillTerminalResponse = {};
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_kill,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      extMethod: async (
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        await this.pushRpcLog(managed, method, "agent_to_client", "request", params);
        throw acp.RequestError.methodNotFound(method);
      },

      extNotification: async (method: string, params: Record<string, unknown>): Promise<void> => {
        await this.pushRpcLog(managed, method, "agent_to_client", "notification", params);
      },
    };
  }

  private async stopRuntime(runtime: StartedRuntime): Promise<void> {
    await runtime.terminate().catch(() => {});
  }
}
