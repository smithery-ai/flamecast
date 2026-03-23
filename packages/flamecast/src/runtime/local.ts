import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  FileSystemSnapshotSchema,
  SESSION_EVENT_TYPES,
  type AgentSpawn,
  type AgentTemplateRuntime,
  type FilePreview,
  type FileSystemSnapshot,
  type PendingPermissionOption,
  type PermissionResponseBody,
  type PromptQueueState,
  type QueuedPromptResponse,
  type SessionLog,
} from "../shared/session.js";
import type { FlamecastStorage } from "../flamecast/storage.js";
import type { RuntimeProviderRegistry, StartedRuntime } from "../flamecast/runtime-provider.js";
import { buildFileSystemSnapshot } from "../flamecast/runtime-provider.js";
import type { RuntimeClient } from "./client.js";
import { AcpBridge } from "./acp-bridge.js";

interface ManagedSession {
  id: string;
  workspaceRoot: string;
  pendingLogs: SessionLog[];
  bufferPendingLogs: boolean;
  bridge: AcpBridge;
  terminate: () => Promise<void>;
  lastFileSystemSnapshot: FileSystemSnapshot | null;
  inFlightPromptId: string | null;
  promptQueue: Array<{ queueId: string; text: string; enqueuedAt: string }>;
}

type LocalRuntimeClientOptions = {
  runtimeProviders: RuntimeProviderRegistry;
  getStorage: () => FlamecastStorage;
  onSessionEvent?: (sessionId: string, event: SessionLog) => void;
};

export class LocalRuntimeClient implements RuntimeClient {
  private static readonly MAX_FILE_PREVIEW_CHARS = 20_000;
  private static readonly MAX_QUEUE_SIZE = 50;
  private readonly runtimeProviders: RuntimeProviderRegistry;
  private readonly getStorage: () => FlamecastStorage;
  private readonly onSessionEvent?: (sessionId: string, event: SessionLog) => void;
  private readonly runtimes = new Map<string, ManagedSession>();
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

    const bridge = new AcpBridge(startedRuntime.transport, cwd);
    const managed: ManagedSession = {
      id: "",
      workspaceRoot: cwd,
      pendingLogs: [],
      bufferPendingLogs: true,
      bridge,
      terminate: startedRuntime.terminate,
      lastFileSystemSnapshot: null,
      inFlightPromptId: null,
      promptQueue: [],
    };

    // Subscribe to bridge events — route to storage + SSE
    this.wireBridgeEvents(managed);

    try {
      const initParams: acp.InitializeRequest = {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      };

      await bridge.initialize(initParams);

      const agentCwd = startedRuntime.agentCwd ?? cwd;
      const newSessionParams: acp.NewSessionRequest = { cwd: agentCwd, mcpServers: [] };
      const sessionResult = await bridge.newSession(newSessionParams);

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

  async promptSession(
    sessionId: string,
    text: string,
  ): Promise<acp.PromptResponse | QueuedPromptResponse> {
    const managed = this.resolveRuntime(sessionId);
    if (!managed.bridge.isInitialized) {
      throw new Error(`Session "${sessionId}" is not initialized`);
    }

    if (managed.inFlightPromptId === null) {
      return this.executePrompt(managed, text);
    }

    return this.enqueuePrompt(managed, text);
  }

  getQueueState(sessionId: string): PromptQueueState {
    const managed = this.resolveRuntime(sessionId);
    return this.buildQueueState(managed);
  }

  async cancelQueuedPrompt(sessionId: string, queueId: string): Promise<void> {
    const managed = this.resolveRuntime(sessionId);

    const index = managed.promptQueue.findIndex((item) => item.queueId === queueId);
    if (index === -1) {
      throw new Error(`Queued prompt "${queueId}" not found`);
    }

    const [removed] = managed.promptQueue.splice(index, 1);
    await this.pushLog(managed, "prompt_cancelled", {
      queueId: removed.queueId,
      text: removed.text,
    });
  }

  private async executePrompt(managed: ManagedSession, text: string): Promise<acp.PromptResponse> {
    if (!managed.bridge.isInitialized) {
      throw new Error(`Session "${managed.id}" is not initialized`);
    }

    const promptId = randomUUID();
    managed.inFlightPromptId = promptId;

    const promptParams: acp.PromptRequest = {
      sessionId: managed.id,
      prompt: [{ type: "text", text }],
    };

    try {
      const result = await managed.bridge.prompt(promptParams);
      return result;
    } finally {
      managed.inFlightPromptId = null;
      void this.dequeueNext(managed);
    }
  }

  private async enqueuePrompt(
    managed: ManagedSession,
    text: string,
  ): Promise<QueuedPromptResponse> {
    if (managed.promptQueue.length >= LocalRuntimeClient.MAX_QUEUE_SIZE) {
      throw new Error("Prompt queue is full");
    }

    const queueId = randomUUID();
    const enqueuedAt = new Date().toISOString();
    const position = managed.promptQueue.length + 1;

    managed.promptQueue.push({ queueId, text, enqueuedAt });

    await this.pushLog(managed, "prompt_queued", { queueId, text, position });

    return { queued: true, queueId, position };
  }

  private async dequeueNext(managed: ManagedSession): Promise<void> {
    if (!this.runtimes.has(managed.id)) return;

    const next = managed.promptQueue.shift();
    if (!next) return;

    await this.pushLog(managed, "prompt_dequeued", {
      queueId: next.queueId,
      text: next.text,
    });

    try {
      await this.executePrompt(managed, next.text);
    } catch (error) {
      await this.pushLog(managed, "prompt_error", {
        queueId: next.queueId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildQueueState(managed: ManagedSession): PromptQueueState {
    const queue = managed.promptQueue ?? [];
    return {
      processing: (managed.inFlightPromptId ?? null) !== null,
      items: queue.map((item, index) => ({
        queueId: item.queueId,
        text: item.text,
        enqueuedAt: item.enqueuedAt,
        position: index + 1,
      })),
      size: queue.length,
    };
  }

  async resolvePermission(
    sessionId: string,
    requestId: string,
    body: PermissionResponseBody,
  ): Promise<void> {
    const managed = this.resolveRuntime(sessionId);
    const storage = this.getStorage();
    const meta = await storage.getSessionMeta(managed.id);
    const permission = meta?.pendingPermission;

    if (!permission || permission.requestId !== requestId) {
      throw new Error("Permission request not found or already resolved");
    }

    await storage.updateSession(managed.id, { pendingPermission: null });

    if ("outcome" in body && body.outcome === "cancelled") {
      await this.pushLog(managed, "permission_cancelled", {
        requestId: permission.requestId,
        toolCallId: permission.toolCallId,
      });
      managed.bridge.resolvePermission(requestId, { outcome: { outcome: "cancelled" } });
      return;
    }

    if (!("optionId" in body)) {
      throw new Error("Invalid permission response");
    }

    const option = permission.options.find(
      (candidate: PendingPermissionOption) => candidate.optionId === body.optionId,
    );
    if (!option) {
      throw new Error(`Unknown permission option "${body.optionId}"`);
    }

    await this.pushLog(managed, this.getPermissionLogType(option.kind), {
      requestId: permission.requestId,
      toolCallId: permission.toolCallId,
      optionId: option.optionId,
      optionName: option.name,
    });
    managed.bridge.resolvePermission(requestId, {
      outcome: { outcome: "selected", optionId: option.optionId },
    });
  }

  async terminateSession(sessionId: string): Promise<void> {
    const managed = this.resolveRuntime(sessionId);
    const storage = this.getStorage();

    if (managed.promptQueue.length > 0) {
      const droppedCount = managed.promptQueue.length;
      managed.promptQueue = [];
      await this.pushLog(managed, "queue_cleared", {
        reason: "terminated",
        droppedCount,
      });
    }
    managed.inFlightPromptId = null;

    await managed.bridge.flush();
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

  // ---- Bridge event wiring ----

  private wireBridgeEvents(managed: ManagedSession): void {
    const bridge = managed.bridge;

    bridge.on("rpc", (event) => {
      const data: Record<string, unknown> = {
        method: event.method,
        direction: event.direction,
        phase: event.phase,
      };
      if (event.payload !== undefined) data.payload = event.payload;
      void this.pushLog(managed, "rpc", data);
    });

    bridge.on("log", (event) => {
      void this.pushLog(managed, event.type, event.data);
    });

    bridge.on("permissionRequest", async (event) => {
      const now = new Date().toISOString();
      await this.getStorage().updateSession(managed.id, {
        pendingPermission: event.pendingPermission,
        lastUpdatedAt: now,
      });
    });
  }

  // ---- Internal helpers ----

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

  private async stopRuntime(runtime: StartedRuntime): Promise<void> {
    await runtime.terminate().catch(() => {});
  }
}
