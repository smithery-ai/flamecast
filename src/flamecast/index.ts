import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentProcessInfo,
  AgentSpawn,
  ConnectionInfo,
  CreateConnectionBody,
  PendingPermission,
  PendingPermissionOption,
  PermissionResponseBody,
  RegisterAgentProcessBody,
} from "../shared/connection.js";
import {
  getAgentTransport,
  getBuiltinAgentProcessPresets,
  startAgentProcess,
} from "./transport.js";

export type { AgentProcessInfo, ConnectionInfo, PendingPermission } from "../shared/connection.js";

// Runtime-only callback used to resume a pending permission request.
type PermissionResolver = (response: acp.RequestPermissionResponse) => void;

/** Coalesces RPC log rows for streaming text session updates (see `flushSessionTextChunkLogBuffer`). */
type StreamingTextChunkKind = "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk";

interface SessionTextChunkLogBuffer {
  sessionId: string;
  kind: StreamingTextChunkKind;
  /** From ACP `ContentChunk.messageId`; chunks with different ids are separate messages. */
  messageId: string | null;
  texts: string[];
}

// Full in-memory connection record, including runtime-only handles.
interface ManagedConnection {
  info: ConnectionInfo;
  runtime: {
    connection: acp.ClientSideConnection | null;
    agentProcess: ChildProcess;
    sessionTextChunkLogBuffer: SessionTextChunkLogBuffer | null;
  };
}

export class Flamecast {
  private connections = new Map<string, ManagedConnection>();
  private permissionResolvers = new Map<string, PermissionResolver>();
  private agentProcesses = new Map<string, { label: string; spawn: AgentSpawn }>();
  private nextId = 1;

  constructor() {
    for (const preset of getBuiltinAgentProcessPresets()) {
      this.agentProcesses.set(preset.id, {
        label: preset.label,
        spawn: { command: preset.spawn.command, args: preset.spawn.args },
      });
    }
  }

  listAgentProcesses(): AgentProcessInfo[] {
    return [...this.agentProcesses.entries()].map(([id, row]) => ({
      id,
      label: row.label,
      spawn: row.spawn,
    }));
  }

  registerAgentProcess(body: RegisterAgentProcessBody): AgentProcessInfo {
    const id = randomUUID();
    const spawn: AgentSpawn = {
      command: body.spawn.command,
      args: body.spawn.args,
    };
    this.agentProcesses.set(id, { label: body.label, spawn });
    return { id, label: body.label, spawn };
  }

  async create(opts: CreateConnectionBody): Promise<ConnectionInfo> {
    const cwd = opts.cwd ?? process.cwd();
    const id = String(this.nextId++);
    const now = new Date().toISOString();

    let agentLabel: string;
    let spawn: AgentSpawn;

    if (opts.agentProcessId) {
      const def = this.agentProcesses.get(opts.agentProcessId);
      if (!def) {
        throw new Error(`Unknown agent process "${opts.agentProcessId}"`);
      }
      agentLabel = def.label;
      spawn = def.spawn;
    } else if (opts.spawn) {
      spawn = opts.spawn;
      agentLabel =
        opts.label?.trim() || [spawn.command, ...(spawn.args ?? [])].filter(Boolean).join(" ");
    } else {
      throw new Error("Provide agentProcessId or spawn");
    }

    const agentProcess = startAgentProcess(spawn);

    const { input, output } = getAgentTransport(agentProcess);
    const stream = acp.ndJsonStream(input, output);

    const managed: ManagedConnection = {
      info: {
        id,
        agentLabel,
        spawn,
        sessionId: "",
        startedAt: now,
        lastUpdatedAt: now,
        logs: [],
        pendingPermission: null,
      },
      runtime: {
        connection: null,
        agentProcess,
        sessionTextChunkLogBuffer: null,
      },
    };

    const client = this.createClient(managed);
    const connection = new acp.ClientSideConnection((_agent) => client, stream);
    managed.runtime.connection = connection;

    const initParams: acp.InitializeRequest = {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    };
    this.pushRpcLog(
      managed,
      acp.AGENT_METHODS.initialize,
      "client_to_agent",
      "request",
      initParams,
    );
    const initResult = await connection.initialize(initParams);
    this.pushRpcLog(
      managed,
      acp.AGENT_METHODS.initialize,
      "agent_to_client",
      "response",
      initResult,
    );

    const newSessionParams: acp.NewSessionRequest = { cwd, mcpServers: [] };
    this.pushRpcLog(
      managed,
      acp.AGENT_METHODS.session_new,
      "client_to_agent",
      "request",
      newSessionParams,
    );
    const sessionResult = await connection.newSession(newSessionParams);
    this.pushRpcLog(
      managed,
      acp.AGENT_METHODS.session_new,
      "agent_to_client",
      "response",
      sessionResult,
    );

    managed.info.sessionId = sessionResult.sessionId;

    this.connections.set(id, managed);
    return this.snapshotInfo(managed);
  }

  list(): ConnectionInfo[] {
    return [...this.connections.values()].map((m) => this.snapshotInfo(m));
  }

  get(id: string): ConnectionInfo {
    return this.snapshotInfo(this.resolve(id));
  }

  async prompt(id: string, text: string): Promise<acp.PromptResponse> {
    const managed = this.resolve(id);
    if (!managed.runtime.connection) {
      throw new Error(`Connection "${id}" is not initialized`);
    }
    const promptParams: acp.PromptRequest = {
      sessionId: managed.info.sessionId,
      prompt: [{ type: "text", text }],
    };
    this.pushRpcLog(
      managed,
      acp.AGENT_METHODS.session_prompt,
      "client_to_agent",
      "request",
      promptParams,
    );

    try {
      const result = await managed.runtime.connection.prompt(promptParams);
      this.flushSessionTextChunkLogBuffer(managed);
      this.pushRpcLog(
        managed,
        acp.AGENT_METHODS.session_prompt,
        "agent_to_client",
        "response",
        result,
      );
      return result;
    } catch (e) {
      this.flushSessionTextChunkLogBuffer(managed);
      throw e;
    }
  }

  kill(id: string): void {
    const managed = this.resolve(id);
    if (managed.info.pendingPermission) {
      this.permissionResolvers.delete(managed.info.pendingPermission.requestId);
    }
    this.flushSessionTextChunkLogBuffer(managed);
    managed.runtime.agentProcess.kill();
    this.pushLog(managed, "killed", {});
    this.connections.delete(id);
  }

  respondToPermission(id: string, requestId: string, body: PermissionResponseBody): void {
    const managed = this.resolve(id);
    const pending = this.takePendingPermissionResolution(managed, requestId);

    if ("outcome" in body && body.outcome === "cancelled") {
      this.logPermissionCancelled(managed, pending);
      pending.resolve({ outcome: { outcome: "cancelled" } });
      return;
    }

    if (!("optionId" in body)) {
      throw new Error("Invalid permission response");
    }

    const option = this.getPermissionOption(pending, body.optionId);
    this.logPermissionSelection(managed, pending, option);
    pending.resolve({
      outcome: { outcome: "selected", optionId: option.optionId },
    });
  }

  private resolve(id: string): ManagedConnection {
    const managed = this.connections.get(id);
    if (!managed) {
      throw new Error(`Connection "${id}" not found`);
    }
    return managed;
  }

  private snapshotInfo(managed: ManagedConnection): ConnectionInfo {
    return {
      ...managed.info,
      logs: [...managed.info.logs],
      pendingPermission: managed.info.pendingPermission
        ? {
            ...managed.info.pendingPermission,
            options: managed.info.pendingPermission.options.map((option) => ({
              ...option,
            })),
          }
        : null,
    };
  }

  private pushLog(managed: ManagedConnection, type: string, data: Record<string, unknown>): void {
    const now = new Date().toISOString();
    managed.info.lastUpdatedAt = now;
    managed.info.logs.push({ timestamp: now, type, data });
  }

  /**
   * One log row per JSON-RPC request/response/notification, using spec method names
   * from {@link acp.AGENT_METHODS} / {@link acp.CLIENT_METHODS} where applicable.
   */
  private pushRpcLog(
    managed: ManagedConnection,
    method: string,
    direction: "client_to_agent" | "agent_to_client",
    phase: "request" | "response" | "notification",
    payload?: unknown,
  ): void {
    this.pushLog(managed, "rpc", {
      method,
      direction,
      phase,
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  /**
   * Writes one `rpc` row for all consecutive text chunks of the same stream
   * (`sessionId` + chunk kind + optional `messageId`). Any other `session/update`
   * flushes first so tool calls, plan updates, etc. stay ordered correctly.
   */
  private flushSessionTextChunkLogBuffer(managed: ManagedConnection): void {
    const buf = managed.runtime.sessionTextChunkLogBuffer;
    if (!buf || buf.texts.length === 0) {
      managed.runtime.sessionTextChunkLogBuffer = null;
      return;
    }
    managed.runtime.sessionTextChunkLogBuffer = null;
    let combined: string;
    try {
      combined = buf.texts.join("");
    } catch (e) {
      this.pushLog(managed, "rpc_coalesce_error", {
        reason: "join_failed",
        message: e instanceof Error ? e.message : String(e),
        partialParts: buf.texts.length,
      });
      for (const text of buf.texts) {
        this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.session_update,
          "agent_to_client",
          "notification",
          {
            sessionId: buf.sessionId,
            update: {
              sessionUpdate: buf.kind,
              content: { type: "text", text },
              ...(buf.messageId != null ? { messageId: buf.messageId } : {}),
            },
          },
        );
      }
      return;
    }
    const update = {
      sessionUpdate: buf.kind,
      content: { type: "text" as const, text: combined },
      ...(buf.messageId != null ? { messageId: buf.messageId } : {}),
    } satisfies acp.SessionUpdate;
    this.pushRpcLog(managed, acp.CLIENT_METHODS.session_update, "agent_to_client", "notification", {
      sessionId: buf.sessionId,
      update,
    });
  }

  private logSessionUpdateNotification(
    managed: ManagedConnection,
    params: acp.SessionNotification,
  ): void {
    const u = params.update;
    if (
      (u.sessionUpdate === "agent_message_chunk" ||
        u.sessionUpdate === "user_message_chunk" ||
        u.sessionUpdate === "agent_thought_chunk") &&
      u.content.type === "text" &&
      typeof u.content.text === "string"
    ) {
      const kind = u.sessionUpdate;
      const messageId = u.messageId ?? null;
      const buf = managed.runtime.sessionTextChunkLogBuffer;
      if (
        buf &&
        (buf.sessionId !== params.sessionId ||
          buf.kind !== kind ||
          (buf.messageId ?? null) !== messageId)
      ) {
        this.flushSessionTextChunkLogBuffer(managed);
      }
      const next = managed.runtime.sessionTextChunkLogBuffer;
      if (next) {
        next.texts.push(u.content.text);
      } else {
        managed.runtime.sessionTextChunkLogBuffer = {
          sessionId: params.sessionId,
          kind,
          messageId,
          texts: [u.content.text],
        };
      }
      return;
    }

    this.flushSessionTextChunkLogBuffer(managed);
    this.pushRpcLog(
      managed,
      acp.CLIENT_METHODS.session_update,
      "agent_to_client",
      "notification",
      params,
    );
  }

  private takePendingPermissionResolution(
    managed: ManagedConnection,
    requestId: string,
  ): { permission: PendingPermission; resolve: PermissionResolver } {
    const permission = managed.info.pendingPermission;
    const resolve = this.permissionResolvers.get(requestId);
    if (!permission || permission.requestId !== requestId || !resolve) {
      throw new Error("Permission request not found or already resolved");
    }
    managed.info.pendingPermission = null;
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

  private logPermissionCancelled(
    managed: ManagedConnection,
    pending: { permission: PendingPermission; resolve: PermissionResolver },
  ): void {
    this.pushLog(managed, "permission_cancelled", {
      requestId: pending.permission.requestId,
      toolCallId: pending.permission.toolCallId,
    });
  }

  private logPermissionSelection(
    managed: ManagedConnection,
    pending: { permission: PendingPermission; resolve: PermissionResolver },
    option: PendingPermissionOption,
  ): void {
    this.pushLog(managed, this.getPermissionLogType(option.kind), {
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

  private createClient(managed: ManagedConnection): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        this.logSessionUpdateNotification(managed, params);
      },

      requestPermission: async (
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> => {
        this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.session_request_permission,
          "agent_to_client",
          "request",
          params,
        );
        const pendingPermission = this.createPendingPermission(params);
        managed.info.pendingPermission = pendingPermission;
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          const wrapped: PermissionResolver = (response) => {
            this.pushRpcLog(
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
        this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.fs_read_text_file,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.ReadTextFileResponse = { content: "" };
        this.pushRpcLog(
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
        this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.fs_write_text_file,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.WriteTextFileResponse = {};
        this.pushRpcLog(
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
        this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_create,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.CreateTerminalResponse = { terminalId: `stub-${randomUUID()}` };
        this.pushRpcLog(
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
        this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_output,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.TerminalOutputResponse = { output: "", truncated: false };
        this.pushRpcLog(
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
        this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_release,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.ReleaseTerminalResponse = {};
        this.pushRpcLog(
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
        this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_wait_for_exit,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.WaitForTerminalExitResponse = { exitCode: 0 };
        this.pushRpcLog(
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
        this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_kill,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.KillTerminalResponse = {};
        this.pushRpcLog(
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
        this.pushRpcLog(managed, method, "agent_to_client", "request", params);
        throw acp.RequestError.methodNotFound(method);
      },

      extNotification: async (method: string, params: Record<string, unknown>): Promise<void> => {
        this.pushRpcLog(managed, method, "agent_to_client", "notification", params);
      },
    };
  }
}
