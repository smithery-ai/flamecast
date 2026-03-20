import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentProcessInfo,
  AgentSpawn,
  ConnectionLog,
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

export interface ConnectionRuntimeOptions {
  autoApprovePermissions?: boolean;
  envOverrides?: NodeJS.ProcessEnv;
}

export interface CapturedPromptResult {
  assistantText: string;
  logs: ConnectionLog[];
  result: acp.PromptResponse;
}

function extractAgentMessageText(data: Record<string, unknown>): string {
  if (data.sessionUpdate !== "agent_message_chunk") {
    return "";
  }
  const content = data.content;
  if (typeof content !== "object" || content === null) {
    return "";
  }
  const text = Reflect.get(content, "text");
  return typeof text === "string" ? text : "";
}

// Full in-memory connection record, including runtime-only handles.
interface ManagedConnection {
  info: ConnectionInfo;
  runtime: {
    autoApprovePermissions: boolean;
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

  async create(
    opts: CreateConnectionBody,
    runtimeOptions: ConnectionRuntimeOptions = {},
  ): Promise<ConnectionInfo> {
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

    const agentProcess = startAgentProcess(spawn, runtimeOptions.envOverrides);

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
        autoApprovePermissions: runtimeOptions.autoApprovePermissions ?? false,
        connection: null,
        agentProcess,
      },
    };

    const client = this.createClient(managed);
    const connection = new acp.ClientSideConnection((_agent) => client, stream);
    managed.runtime.connection = connection;

    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    this.pushLog(managed, "initialized", {
      protocolVersion: initResult.protocolVersion,
    });

    const sessionResult = await connection.newSession({
      cwd,
      mcpServers: [],
    });

    managed.info.sessionId = sessionResult.sessionId;
    this.pushLog(managed, "session_created", {
      sessionId: sessionResult.sessionId,
    });

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
    this.pushLog(managed, "prompt_sent", { text });

    const result = await managed.runtime.connection.prompt({
      sessionId: managed.info.sessionId,
      prompt: [{ type: "text", text }],
    });

    this.pushLog(managed, "prompt_completed", {
      stopReason: result.stopReason,
    });
    return result;
  }

  async promptCaptured(id: string, text: string): Promise<CapturedPromptResult> {
    const managed = this.resolve(id);
    const startIndex = managed.info.logs.length;
    const result = await this.prompt(id, text);
    const logs = managed.info.logs.slice(startIndex).map((entry) => ({
      ...entry,
      data: { ...entry.data },
    }));
    const assistantText = logs
      .filter((entry) => entry.type === "session_update")
      .map((entry) => extractAgentMessageText(entry.data))
      .join("");
    return {
      assistantText,
      logs,
      result,
    };
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
        const update = params.update;
        const entry: Record<string, unknown> = {
          sessionUpdate: update.sessionUpdate,
        };

        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            entry.content = update.content;
            break;
          case "tool_call":
            entry.toolCallId = update.toolCallId;
            entry.title = update.title;
            entry.kind = update.kind;
            entry.status = update.status;
            break;
          case "tool_call_update":
            entry.toolCallId = update.toolCallId;
            entry.status = update.status;
            break;
          case "plan":
            entry.plan = update;
            break;
          default:
            entry.raw = update;
            break;
        }

        this.pushLog(managed, "session_update", entry);
      },

      requestPermission: async (
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> => {
        if (managed.runtime.autoApprovePermissions) {
          const option = this.selectAutoApprovalOption(params.options);
          this.pushLog(managed, "permission_auto_approved", {
            optionId: option.optionId,
            optionName: option.name,
            toolCallId: params.toolCall.toolCallId,
          });
          return {
            outcome: {
              outcome: "selected",
              optionId: option.optionId,
            },
          };
        }
        const pendingPermission = this.createPendingPermission(params);
        managed.info.pendingPermission = pendingPermission;
        this.pushLog(managed, "permission_requested", {
          requestId: pendingPermission.requestId,
          toolCallId: pendingPermission.toolCallId,
          title: pendingPermission.title,
          options: pendingPermission.options,
        });
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          this.permissionResolvers.set(pendingPermission.requestId, resolve);
        });
      },

      readTextFile: async (params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> => {
        this.pushLog(managed, "read_text_file", { path: params.path });
        return { content: "" };
      },

      writeTextFile: async (
        params: acp.WriteTextFileRequest,
      ): Promise<acp.WriteTextFileResponse> => {
        this.pushLog(managed, "write_text_file", {
          path: params.path,
        });
        return {};
      },
    };
  }

  private selectAutoApprovalOption(
    options: acp.RequestPermissionRequest["options"],
  ): acp.RequestPermissionRequest["options"][number] {
    return (
      options.find((option) => String(option.kind).startsWith("allow")) ??
      options[0] ?? {
        kind: "allow_once",
        name: "Allow",
        optionId: "allow",
      }
    );
  }
}
