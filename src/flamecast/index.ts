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

// Full in-memory connection record, including runtime-only handles.
interface ManagedConnection {
  info: ConnectionInfo;
  runtime: {
    connection: acp.ClientSideConnection | null;
    agentProcess: ChildProcess;
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
    this.pushRpcLog(managed, acp.AGENT_METHODS.initialize, "client_to_agent", "request", initParams);
    const initResult = await connection.initialize(initParams);
    this.pushRpcLog(managed, acp.AGENT_METHODS.initialize, "agent_to_client", "response", initResult);

    const newSessionParams: acp.NewSessionRequest = { cwd, mcpServers: [] };
    this.pushRpcLog(managed, acp.AGENT_METHODS.session_new, "client_to_agent", "request", newSessionParams);
    const sessionResult = await connection.newSession(newSessionParams);
    this.pushRpcLog(managed, acp.AGENT_METHODS.session_new, "agent_to_client", "response", sessionResult);

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
    this.pushRpcLog(managed, acp.AGENT_METHODS.session_prompt, "client_to_agent", "request", promptParams);

    const result = await managed.runtime.connection.prompt(promptParams);

    this.pushRpcLog(managed, acp.AGENT_METHODS.session_prompt, "agent_to_client", "response", result);
    return result;
  }

  kill(id: string): void {
    const managed = this.resolve(id);
    if (managed.info.pendingPermission) {
      this.permissionResolvers.delete(managed.info.pendingPermission.requestId);
    }
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
        this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.session_update,
          "agent_to_client",
          "notification",
          params,
        );
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
        this.pushRpcLog(managed, acp.CLIENT_METHODS.fs_read_text_file, "agent_to_client", "request", params);
        const response: acp.ReadTextFileResponse = { content: "" };
        this.pushRpcLog(managed, acp.CLIENT_METHODS.fs_read_text_file, "client_to_agent", "response", response);
        return response;
      },

      writeTextFile: async (
        params: acp.WriteTextFileRequest,
      ): Promise<acp.WriteTextFileResponse> => {
        this.pushRpcLog(managed, acp.CLIENT_METHODS.fs_write_text_file, "agent_to_client", "request", params);
        const response: acp.WriteTextFileResponse = {};
        this.pushRpcLog(managed, acp.CLIENT_METHODS.fs_write_text_file, "client_to_agent", "response", response);
        return response;
      },

      createTerminal: async (params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> => {
        this.pushRpcLog(managed, acp.CLIENT_METHODS.terminal_create, "agent_to_client", "request", params);
        const response: acp.CreateTerminalResponse = { terminalId: `stub-${randomUUID()}` };
        this.pushRpcLog(managed, acp.CLIENT_METHODS.terminal_create, "client_to_agent", "response", response);
        return response;
      },

      terminalOutput: async (params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> => {
        this.pushRpcLog(managed, acp.CLIENT_METHODS.terminal_output, "agent_to_client", "request", params);
        const response: acp.TerminalOutputResponse = { output: "", truncated: false };
        this.pushRpcLog(managed, acp.CLIENT_METHODS.terminal_output, "client_to_agent", "response", response);
        return response;
      },

      releaseTerminal: async (
        params: acp.ReleaseTerminalRequest,
      ): Promise<acp.ReleaseTerminalResponse | void> => {
        this.pushRpcLog(managed, acp.CLIENT_METHODS.terminal_release, "agent_to_client", "request", params);
        const response: acp.ReleaseTerminalResponse = {};
        this.pushRpcLog(managed, acp.CLIENT_METHODS.terminal_release, "client_to_agent", "response", response);
        return response;
      },

      waitForTerminalExit: async (
        params: acp.WaitForTerminalExitRequest,
      ): Promise<acp.WaitForTerminalExitResponse> => {
        this.pushRpcLog(managed, acp.CLIENT_METHODS.terminal_wait_for_exit, "agent_to_client", "request", params);
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

      killTerminal: async (params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse | void> => {
        this.pushRpcLog(managed, acp.CLIENT_METHODS.terminal_kill, "agent_to_client", "request", params);
        const response: acp.KillTerminalResponse = {};
        this.pushRpcLog(managed, acp.CLIENT_METHODS.terminal_kill, "client_to_agent", "response", response);
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
