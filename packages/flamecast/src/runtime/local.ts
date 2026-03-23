import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  FileSystemSnapshotSchema,
  SESSION_EVENT_TYPES,
  type AgentSpawn,
  type AgentTemplateRuntime,
  type FileSystemSnapshot,
  type SessionLog,
} from "../shared/session.js";
import type { FlamecastStorage } from "../flamecast/storage.js";
import type { RuntimeProviderRegistry, StartedRuntime } from "../flamecast/runtime-provider.js";
import type { RuntimeClient } from "./client.js";
import type { WsSessionHandler } from "./ws-server.js";
import { AcpBridge } from "./acp-bridge.js";

interface ManagedSession {
  id: string;
  workspaceRoot: string;
  bridge: AcpBridge;
  terminate: () => Promise<void>;
  lastFileSystemSnapshot: FileSystemSnapshot | null;
  subscribers: Set<(event: SessionLog) => void>;
}

type LocalRuntimeClientOptions = {
  runtimeProviders: RuntimeProviderRegistry;
  getStorage: () => FlamecastStorage;
};

export class LocalRuntimeClient implements RuntimeClient, WsSessionHandler {
  private readonly runtimeProviders: RuntimeProviderRegistry;
  private readonly getStorage: () => FlamecastStorage;
  private readonly runtimes = new Map<string, ManagedSession>();

  constructor(opts: LocalRuntimeClientOptions) {
    this.runtimeProviders = opts.runtimeProviders;
    this.getStorage = opts.getStorage;
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
      bridge,
      terminate: startedRuntime.terminate,
      lastFileSystemSnapshot: null,
      subscribers: new Set(),
    };

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

      this.runtimes.set(managed.id, managed);
      this.pipeBridgeEvents(managed);
      this.pipeProviderEvents(managed.id, startedRuntime.events);
      return { sessionId: managed.id };
    } catch (error) {
      await this.stopRuntime(startedRuntime);
      throw error;
    }
  }

  async terminateSession(sessionId: string): Promise<void> {
    const managed = this.resolveRuntime(sessionId);
    const storage = this.getStorage();

    await managed.bridge.flush();
    await managed.terminate();
    await storage.finalizeSession(sessionId, "terminated");
    this.runtimes.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  listSessionIds(): string[] {
    return [...this.runtimes.keys()];
  }

  // ---- WsSessionHandler methods ----

  subscribe(sessionId: string, callback: (event: SessionLog) => void): () => void {
    const managed = this.runtimes.get(sessionId);
    if (!managed) {
      return () => {};
    }
    managed.subscribers.add(callback);

    // Send initial filesystem snapshot if available
    console.log("[subscribe] lastFileSystemSnapshot?", !!managed.lastFileSystemSnapshot, "entries:", managed.lastFileSystemSnapshot?.entries?.length);
    if (managed.lastFileSystemSnapshot) {
      callback({
        timestamp: new Date().toISOString(),
        type: SESSION_EVENT_TYPES.FILESYSTEM_SNAPSHOT,
        data: { snapshot: managed.lastFileSystemSnapshot },
      });
    }

    return () => {
      managed.subscribers.delete(callback);
    };
  }

  async promptSession(sessionId: string, text: string): Promise<unknown> {
    const managed = this.resolveRuntime(sessionId);
    return managed.bridge.prompt({
      sessionId: managed.id,
      prompt: [{ type: "text", text }],
    });
  }

  async cancelQueuedPrompt(sessionId: string, queueId: string): Promise<void> {
    const managed = this.resolveRuntime(sessionId);
    managed.bridge.cancelQueuedPrompt(queueId);
  }

  async resolvePermission(
    sessionId: string,
    requestId: string,
    body: { optionId: string } | { outcome: "cancelled" },
  ): Promise<void> {
    const managed = this.resolveRuntime(sessionId);
    if ("optionId" in body) {
      managed.bridge.resolvePermission(requestId, {
        outcome: { outcome: "selected", optionId: body.optionId },
      });
    } else {
      managed.bridge.resolvePermission(requestId, { outcome: { outcome: "cancelled" } });
    }
    // Broadcast resolution so UI clears the permission card
    this.broadcast(sessionId, {
      timestamp: new Date().toISOString(),
      type: "permission_responded",
      data: { requestId },
    });
  }

  async readFileContent(
    sessionId: string,
    path: string,
  ): Promise<{ content: string; truncated: boolean; maxChars: number }> {
    const managed = this.resolveRuntime(sessionId);
    const MAX_CHARS = 100_000;
    const absolutePath = resolve(managed.workspaceRoot, path);
    // Prevent path traversal
    if (!absolutePath.startsWith(managed.workspaceRoot)) {
      throw new Error("Path outside workspace");
    }
    const raw = await readFile(absolutePath, "utf8");
    const truncated = raw.length > MAX_CHARS;
    return {
      content: truncated ? raw.slice(0, MAX_CHARS) : raw,
      truncated,
      maxChars: MAX_CHARS,
    };
  }

  // ---- Internal helpers ----

  private pipeBridgeEvents(managed: ManagedSession): void {
    const sessionId = managed.id;

    managed.bridge.on("rpc", (data) => {
      this.broadcast(sessionId, {
        timestamp: new Date().toISOString(),
        type: "rpc",
        data: data as unknown as Record<string, unknown>,
      });
    });

    managed.bridge.on("permissionRequest", (data) => {
      this.broadcast(sessionId, {
        timestamp: new Date().toISOString(),
        type: "permission_request",
        data: data as unknown as Record<string, unknown>,
      });
    });

    managed.bridge.on("log", (data) => {
      this.broadcast(sessionId, {
        timestamp: new Date().toISOString(),
        type: data.type,
        data: data.data,
      });
    });
  }

  private broadcast(sessionId: string, event: SessionLog): void {
    const managed = this.runtimes.get(sessionId);
    if (!managed) return;
    for (const cb of managed.subscribers) {
      try {
        cb(event);
      } catch {
        // subscriber error — ignore
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
        this.broadcast(sessionId, value);
        read();
      });
    };
    read();
  }

  resolveRuntime(id: string): ManagedSession {
    const managed = this.runtimes.get(id);
    if (!managed) {
      throw new Error(`Session "${id}" not found`);
    }
    return managed;
  }

  async stopRuntime(runtime: StartedRuntime): Promise<void> {
    await runtime.terminate().catch(() => {});
  }
}
