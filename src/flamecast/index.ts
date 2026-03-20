import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentProcessInfo,
  AgentSpawn,
  ConnectionInfo,
  ConnectionLog,
  CreateConnectionBody,
  PendingPermission,
  PendingPermissionOption,
  PermissionResponseBody,
  RegisterAgentProcessBody,
} from "../shared/connection.js";
import type { FlamecastProjection } from "./projection.js";
import {
  getAgentTransport,
  getBuiltinAgentProcessPresets,
  startAgentProcess,
} from "./transport.js";

export type { AgentProcessInfo, ConnectionInfo, PendingPermission } from "../shared/connection.js";
export type { ConnectionMeta, FlamecastProjection } from "./projection.js";
export { MemoryFlamecastProjection } from "./projections/memory/index.js";
export { createPsqlProjection } from "./projections/psql/index.js";
export type { PsqlAppDb } from "./projections/psql/types.js";

type PermissionResolver = (response: acp.RequestPermissionResponse) => void | Promise<void>;

type StreamingTextChunkKind = "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk";

interface SessionTextChunkLogBuffer {
  sessionId: string;
  kind: StreamingTextChunkKind;
  messageId: string | null;
  texts: string[];
}

interface ManagedConnection {
  id: string;
  sessionId: string;
  runtime: {
    connection: acp.ClientSideConnection | null;
    agentProcess: ChildProcess;
    sessionTextChunkLogBuffer: SessionTextChunkLogBuffer | null;
  };
}

export type FlamecastOptions = {
  projection: FlamecastProjection;
};

export class Flamecast {
  private runtimes = new Map<string, ManagedConnection>();
  private permissionResolvers = new Map<string, PermissionResolver>();
  private agentProcesses = new Map<string, { label: string; spawn: AgentSpawn }>();
  private readonly projection: FlamecastProjection;

  constructor(opts: FlamecastOptions) {
    this.projection = opts.projection;
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
    const id = await this.projection.allocateConnectionId();
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

    await this.projection.createConnection({
      id,
      agentLabel,
      spawn,
      sessionId: "",
      startedAt: now,
      lastUpdatedAt: now,
      pendingPermission: null,
    });

    const agentProcess = startAgentProcess(spawn);

    const { input, output } = getAgentTransport(agentProcess);
    const stream = acp.ndJsonStream(input, output);

    const managed: ManagedConnection = {
      id,
      sessionId: "",
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
    await this.pushRpcLog(
      managed,
      acp.AGENT_METHODS.initialize,
      "client_to_agent",
      "request",
      initParams,
    );
    const initResult = await connection.initialize(initParams);
    await this.pushRpcLog(
      managed,
      acp.AGENT_METHODS.initialize,
      "agent_to_client",
      "response",
      initResult,
    );

    const newSessionParams: acp.NewSessionRequest = { cwd, mcpServers: [] };
    await this.pushRpcLog(
      managed,
      acp.AGENT_METHODS.session_new,
      "client_to_agent",
      "request",
      newSessionParams,
    );
    const sessionResult = await connection.newSession(newSessionParams);
    await this.pushRpcLog(
      managed,
      acp.AGENT_METHODS.session_new,
      "agent_to_client",
      "response",
      sessionResult,
    );

    managed.sessionId = sessionResult.sessionId;
    const updatedAt = new Date().toISOString();
    await this.projection.updateConnection(id, {
      sessionId: managed.sessionId,
      lastUpdatedAt: updatedAt,
    });

    this.runtimes.set(id, managed);
    return this.snapshotInfo(id);
  }

  async list(): Promise<ConnectionInfo[]> {
    const ids = [...this.runtimes.keys()];
    return Promise.all(ids.map((id) => this.snapshotInfo(id)));
  }

  async get(id: string): Promise<ConnectionInfo> {
    this.resolveRuntime(id);
    return this.snapshotInfo(id);
  }

  async prompt(id: string, text: string): Promise<acp.PromptResponse> {
    const managed = this.resolveRuntime(id);
    if (!managed.runtime.connection) {
      throw new Error(`Connection "${id}" is not initialized`);
    }
    const promptParams: acp.PromptRequest = {
      sessionId: managed.sessionId,
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
    } catch (e) {
      await this.flushSessionTextChunkLogBuffer(managed);
      throw e;
    }
  }

  async kill(id: string): Promise<void> {
    const managed = this.resolveRuntime(id);
    const meta = await this.projection.getConnectionMeta(id);
    if (meta?.pendingPermission) {
      this.permissionResolvers.delete(meta.pendingPermission.requestId);
    }
    await this.flushSessionTextChunkLogBuffer(managed);
    managed.runtime.agentProcess.kill();
    await this.pushLog(managed, "killed", {});
    await this.projection.finalizeConnection(id, "killed");
    this.runtimes.delete(id);
  }

  async respondToPermission(
    id: string,
    requestId: string,
    body: PermissionResponseBody,
  ): Promise<void> {
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

  private resolveRuntime(id: string): ManagedConnection {
    const managed = this.runtimes.get(id);
    if (!managed) {
      throw new Error(`Connection "${id}" not found`);
    }
    return managed;
  }

  private async snapshotInfo(id: string): Promise<ConnectionInfo> {
    const meta = await this.projection.getConnectionMeta(id);
    if (!meta) {
      throw new Error(`Connection "${id}" not found`);
    }
    const logs = await this.projection.getLogs(id);
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

  private async pushLog(
    managed: ManagedConnection,
    type: string,
    data: Record<string, unknown>,
  ): Promise<ConnectionLog> {
    const now = new Date().toISOString();
    const entry: ConnectionLog = { timestamp: now, type, data };
    await this.projection.appendLog(managed.id, managed.sessionId, entry);
    await this.projection.updateConnection(managed.id, { lastUpdatedAt: now });
    return entry;
  }

  private async pushRpcLog(
    managed: ManagedConnection,
    method: string,
    direction: "client_to_agent" | "agent_to_client",
    phase: "request" | "response" | "notification",
    payload?: unknown,
  ): Promise<void> {
    const data: Record<string, unknown> = { method, direction, phase };
    if (payload !== undefined) data.payload = payload;
    await this.pushLog(managed, "rpc", data);
  }

  private async flushSessionTextChunkLogBuffer(managed: ManagedConnection): Promise<void> {
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
      await this.pushLog(managed, "rpc_coalesce_error", {
        reason: "join_failed",
        message: e instanceof Error ? e.message : String(e),
        partialParts: buf.texts.length,
      });
      for (const text of buf.texts) {
        await this.pushRpcLog(
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
    await this.pushRpcLog(
      managed,
      acp.CLIENT_METHODS.session_update,
      "agent_to_client",
      "notification",
      {
        sessionId: buf.sessionId,
        update,
      },
    );
  }

  private async logSessionUpdateNotification(
    managed: ManagedConnection,
    params: acp.SessionNotification,
  ): Promise<void> {
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
        await this.flushSessionTextChunkLogBuffer(managed);
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
    managed: ManagedConnection,
    requestId: string,
  ): Promise<{ permission: PendingPermission; resolve: PermissionResolver }> {
    const meta = await this.projection.getConnectionMeta(managed.id);
    const permission = meta?.pendingPermission;
    const resolve = this.permissionResolvers.get(requestId);
    if (!permission || permission.requestId !== requestId || !resolve) {
      throw new Error("Permission request not found or already resolved");
    }
    await this.projection.updateConnection(managed.id, { pendingPermission: null });
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
    managed: ManagedConnection,
    pending: { permission: PendingPermission; resolve: PermissionResolver },
  ): Promise<void> {
    await this.pushLog(managed, "permission_cancelled", {
      requestId: pending.permission.requestId,
      toolCallId: pending.permission.toolCallId,
    });
  }

  private async logPermissionSelection(
    managed: ManagedConnection,
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

  private createClient(managed: ManagedConnection): acp.Client {
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
        await this.projection.updateConnection(managed.id, {
          pendingPermission: pendingPermission,
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
}
