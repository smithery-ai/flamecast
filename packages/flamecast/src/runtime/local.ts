import { randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  FileSystemSnapshotSchema,
  SESSION_EVENT_TYPES,
  type AgentSpawn,
  type AgentTemplateRuntime,
  type FilePreview,
  type FileSystemSnapshot,
  type PendingPermission,
  type PendingPermissionOption,
  type PermissionResponseBody,
  type SessionLog,
} from "../shared/session.js";
import type { FlamecastStorage } from "../flamecast/storage.js";
import type { RuntimeProviderRegistry, StartedRuntime } from "../flamecast/runtime-provider.js";
import { buildFileSystemSnapshot } from "../flamecast/runtime-provider.js";
import type { AcpTransport } from "../flamecast/transport.js";
import type { RuntimeClient } from "./client.js";

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
  workspaceRoot: string;
  pendingLogs: SessionLog[];
  bufferPendingLogs: boolean;
  transport: AcpTransport;
  terminate: () => Promise<void>;
  lastFileSystemSnapshot: FileSystemSnapshot | null;
  runtime: {
    connection: acp.ClientSideConnection | null;
    sessionTextChunkLogBuffer: SessionTextChunkLogBuffer | null;
  };
}

type LocalRuntimeClientOptions = {
  runtimeProviders: RuntimeProviderRegistry;
  getStorage: () => FlamecastStorage;
  onSessionEvent?: (sessionId: string, event: SessionLog) => void;
};

export class LocalRuntimeClient implements RuntimeClient {
  private static readonly MAX_FILE_PREVIEW_CHARS = 20_000;
  private readonly runtimeProviders: RuntimeProviderRegistry;
  private readonly getStorage: () => FlamecastStorage;
  private readonly onSessionEvent?: (sessionId: string, event: SessionLog) => void;
  private readonly runtimes = new Map<string, ManagedSession>();
  private readonly permissionResolvers = new Map<string, PermissionResolver>();
  private readonly sseSubscribers = new Map<string, Set<(event: SessionLog) => void>>();

  constructor(opts: LocalRuntimeClientOptions) {
    this.runtimeProviders = opts.runtimeProviders;
    this.getStorage = opts.getStorage;
    this.onSessionEvent = opts.onSessionEvent;
  }

  async startSession(opts: {
    agentName: string;
    spawn: AgentSpawn;
    cwd: string;
    runtime: AgentTemplateRuntime;
    startedAt: string;
  }): Promise<{ sessionId: string }> {
    const cwd = await realpath(resolve(opts.cwd));
    const provider = this.runtimeProviders[opts.runtime.provider];

    if (!provider) {
      throw new Error(`Unknown runtime provider "${opts.runtime.provider}"`);
    }

    const sessionId = randomUUID();
    const startedRuntime = await provider.start({
      runtime: opts.runtime,
      spawn: opts.spawn,
      sessionId,
      cwd,
    });
    const managed: ManagedSession = {
      id: "",
      workspaceRoot: cwd,
      pendingLogs: [],
      bufferPendingLogs: true,
      transport: startedRuntime.transport,
      terminate: startedRuntime.terminate,
      lastFileSystemSnapshot: null,
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

      managed.pendingLogs.push(
        this.createRpcLog(acp.AGENT_METHODS.initialize, "client_to_agent", "request", initParams),
      );
      const initResult = await connection.initialize(initParams);
      managed.pendingLogs.push(
        this.createRpcLog(acp.AGENT_METHODS.initialize, "agent_to_client", "response", initResult),
      );

      const agentCwd = startedRuntime.agentCwd ?? cwd;
      const newSessionParams: acp.NewSessionRequest = { cwd: agentCwd, mcpServers: [] };
      managed.pendingLogs.push(
        this.createRpcLog(
          acp.AGENT_METHODS.session_new,
          "client_to_agent",
          "request",
          newSessionParams,
        ),
      );
      const sessionResult = await connection.newSession(newSessionParams);
      managed.pendingLogs.push(
        this.createRpcLog(
          acp.AGENT_METHODS.session_new,
          "agent_to_client",
          "response",
          sessionResult,
        ),
      );

      managed.id = sessionResult.sessionId;

      // Create the session row in storage before flushing buffered logs
      const storage = this.getStorage();
      const now = new Date().toISOString();

      await storage.createSession({
        id: managed.id,
        agentName: opts.agentName,
        spawn: opts.spawn,
        startedAt: opts.startedAt,
        lastUpdatedAt: now,
        status: "active",
        pendingPermission: null,
      });

      for (const log of managed.pendingLogs) {
        await storage.appendLog(managed.id, log);
      }
      managed.pendingLogs = [];
      managed.bufferPendingLogs = false;

      this.runtimes.set(managed.id, managed);
      this.pipeProviderEvents(managed.id, startedRuntime.events);
      return { sessionId: managed.id };
    } catch (error) {
      await this.stopRuntime(startedRuntime);
      throw error;
    }
  }

  async promptSession(sessionId: string, text: string): Promise<acp.PromptResponse> {
    const managed = this.resolveRuntime(sessionId);
    if (!managed.runtime.connection) {
      throw new Error(`Session "${sessionId}" is not initialized`);
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

  async resolvePermission(
    sessionId: string,
    requestId: string,
    body: PermissionResponseBody,
  ): Promise<void> {
    const managed = this.resolveRuntime(sessionId);
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

  async terminateSession(sessionId: string): Promise<void> {
    const managed = this.resolveRuntime(sessionId);
    const storage = this.getStorage();
    const meta = await storage.getSessionMeta(sessionId);
    if (meta?.pendingPermission) {
      this.permissionResolvers.delete(meta.pendingPermission.requestId);
    }

    await this.flushSessionTextChunkLogBuffer(managed);
    await managed.terminate();
    await this.pushLog(managed, "killed", {});
    await storage.finalizeSession(sessionId, "terminated");
    this.emitSessionEvent(
      sessionId,
      this.createLogEntry(SESSION_EVENT_TYPES.SESSION_TERMINATED, {}),
    );
    this.sseSubscribers.delete(sessionId);
    this.runtimes.delete(sessionId);
  }

  async getFileSystemSnapshot(
    sessionId: string,
    opts?: { showAllFiles?: boolean },
  ): Promise<FileSystemSnapshot | null> {
    const managed = this.runtimes.get(sessionId);
    if (!managed) {
      return null;
    }
    if (managed.lastFileSystemSnapshot && !opts?.showAllFiles) {
      return managed.lastFileSystemSnapshot;
    }
    return buildFileSystemSnapshot(managed.workspaceRoot, {
      showAllFiles: opts?.showAllFiles === true,
    });
  }

  async getFilePreview(sessionId: string, path: string): Promise<FilePreview> {
    const managed = this.resolveRuntime(sessionId);
    const absolutePath = await this.resolvePreviewPath(managed.workspaceRoot, path);
    const content = await readFile(absolutePath, "utf8");

    return {
      path,
      content: content.slice(0, LocalRuntimeClient.MAX_FILE_PREVIEW_CHARS),
      truncated: content.length > LocalRuntimeClient.MAX_FILE_PREVIEW_CHARS,
      maxChars: LocalRuntimeClient.MAX_FILE_PREVIEW_CHARS,
    };
  }

  subscribe(sessionId: string, callback: (event: SessionLog) => void): () => void {
    let subscribers = this.sseSubscribers.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.sseSubscribers.set(sessionId, subscribers);
    }
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
      if (subscribers.size === 0) {
        this.sseSubscribers.delete(sessionId);
      }
    };
  }

  hasSession(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  listSessionIds(): string[] {
    return [...this.runtimes.keys()];
  }

  // ---- Internal helpers (exposed as package-private for test reflection) ----

  private emitSessionEvent(sessionId: string, event: SessionLog): void {
    this.onSessionEvent?.(sessionId, event);
    const subscribers = this.sseSubscribers.get(sessionId);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(event);
        } catch {
          // Subscriber errors must not disrupt the emitter
        }
      }
    }
  }

  private pipeProviderEvents(sessionId: string, events?: ReadableStream<SessionLog>): void {
    if (!events) return;

    const reader = events.getReader();
    const read = (): void => {
      void reader.read().then(({ value, done }) => {
        const managed = this.runtimes.get(sessionId);
        if (done || !managed) return;
        if (value.type === SESSION_EVENT_TYPES.FILESYSTEM_SNAPSHOT && value.data.snapshot) {
          const parsed = FileSystemSnapshotSchema.safeParse(value.data.snapshot);
          if (parsed.success) {
            managed.lastFileSystemSnapshot = parsed.data;
          }
        }
        this.emitSessionEvent(sessionId, value);
        read();
      });
    };
    read();
  }

  private resolveRuntime(id: string): ManagedSession {
    const managed = this.runtimes.get(id);
    if (!managed) {
      throw new Error(`Session "${id}" not found`);
    }
    return managed;
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
    if (managed.bufferPendingLogs) {
      managed.pendingLogs.push(entry);
      return entry;
    }
    const storage = this.getStorage();
    await storage.appendLog(managed.id, entry);
    await storage.updateSession(managed.id, { lastUpdatedAt: entry.timestamp });
    this.emitSessionEvent(managed.id, entry);
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
    if (managed.bufferPendingLogs) {
      managed.pendingLogs.push(entry);
      return;
    }
    const storage = this.getStorage();
    await storage.appendLog(managed.id, entry);
    await storage.updateSession(managed.id, { lastUpdatedAt: entry.timestamp });
    this.emitSessionEvent(managed.id, entry);
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
    const storage = this.getStorage();
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

        await this.getStorage().updateSession(managed.id, {
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
        const absolutePath = await this.resolveSessionFilePath(managed.workspaceRoot, params.path);
        const content = await readFile(absolutePath, "utf8");
        const lines = content.split("\n");
        const startLine = Math.max(params.line ?? 0, 0);
        const limitedLines =
          params.limit != null
            ? lines.slice(startLine, startLine + params.limit)
            : lines.slice(startLine);
        const response: acp.ReadTextFileResponse = { content: limitedLines.join("\n") };
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
        const absolutePath = await this.resolveSessionWritePath(managed.workspaceRoot, params.path);
        await writeFile(absolutePath, params.content, "utf8");
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

  private async resolvePreviewPath(workspaceRoot: string, path: string): Promise<string> {
    if (isAbsolute(path)) {
      throw new Error(`File preview paths must be relative: "${path}"`);
    }

    const requestedPath = resolve(workspaceRoot, path);
    const realPath = await realpath(requestedPath);
    const rel = relative(workspaceRoot, realPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path "${path}" is outside workspace root`);
    }
    return realPath;
  }

  private async resolveSessionFilePath(workspaceRoot: string, path: string): Promise<string> {
    if (!isAbsolute(path)) {
      throw new Error(`File paths must be absolute: "${path}"`);
    }

    const realPath = await realpath(path);
    const rel = relative(workspaceRoot, realPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path "${path}" is outside workspace root`);
    }
    return realPath;
  }

  private async resolveSessionWritePath(workspaceRoot: string, path: string): Promise<string> {
    if (!isAbsolute(path)) {
      throw new Error(`File paths must be absolute: "${path}"`);
    }

    const requestedPath = resolve(path);
    const rel = relative(workspaceRoot, requestedPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path "${path}" is outside workspace root`);
    }
    return requestedPath;
  }

  private async stopRuntime(runtime: StartedRuntime): Promise<void> {
    await runtime.terminate().catch(() => {});
  }
}
