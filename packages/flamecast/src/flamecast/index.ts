const randomUUID = (): string => crypto.randomUUID();
import type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  CreateSessionBody,
  FilePreview,
  FileSystemSnapshot,
  RegisterAgentTemplateBody,
  Session,
  SessionLog,
  WebhookConfig,
  WebhookEventType,
} from "../shared/session.js";
import { createServerApp } from "./app.js";
import type { FlamecastStorage } from "./storage.js";
import { MemoryFlamecastStorage } from "./storage/memory/index.js";
import { SessionService } from "./session-service.js";
import { WebhookDeliveryEngine } from "./events/webhooks.js";
import { EventBus } from "./events/bus.js";
import { resolveAgentId } from "./events/channels.js";
import type {
  SessionCallbackEvent,
  PermissionCallbackResponse,
} from "@flamecast/protocol/session-host";
import type {
  Runtime,
  RuntimeInfo,
  RuntimeInstance,
  RuntimeNames,
  SessionContext,
  SessionEndReason,
} from "@flamecast/protocol/runtime";

async function readProxyErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "(unreadable)");
  try {
    const parsed: { error?: string } = JSON.parse(text);
    return parsed.error ?? text;
  } catch {
    return text;
  }
}

class ProxyRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ProxyRequestError";
    this.status = status;
  }
}

// Public API types — all sourced from @flamecast/protocol
export type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  Session,
  SessionLog,
  PendingPermission,
  FileSystemSnapshot,
  PermissionResponseBody,
  CreateSessionBody,
  RegisterAgentTemplateBody,
  WebhookConfig,
  WebhookEventType,
} from "@flamecast/protocol/session";
export type { FileSystemEntry } from "@flamecast/protocol/session-host";

export type { RuntimeInstance, RuntimeInfo } from "@flamecast/protocol/runtime";
export type { SessionMeta, SessionRuntimeInfo, FlamecastStorage } from "./storage.js";
export { NodeRuntime } from "./runtime-node.js";

// ---------------------------------------------------------------------------
// Event handler context types
// ---------------------------------------------------------------------------

/** Permission-request outcomes returned by the handler. */
export type PermissionResponse = { optionId: string } | { outcome: "cancelled" };

/**
 * Context passed to `onPermissionRequest`.
 *
 * The session-host POSTs permission requests to the control plane's callback URL.
 * If the handler returns a response, it's sent back synchronously and the agent
 * continues. If it returns `undefined`, the request is deferred to the WS-based
 * UI flow.
 */
export interface PermissionRequestContext<
  R extends Record<string, Runtime<Record<string, unknown>>>,
> {
  session: SessionContext<R>;
  requestId: string;
  toolCallId: string;
  title: string;
  kind: string | undefined;
  options: Array<{ optionId: string; name: string; kind: string }>;
  /** Convenience: return `allow()` to approve with the first "approve"-kind option. */
  allow(): PermissionResponse;
  /** Convenience: return `deny()` to reject with the first "reject"-kind option. */
  deny(): PermissionResponse;
}

/** Context passed to `onSessionEnd`. */
export interface SessionEndContext<R extends Record<string, Runtime<Record<string, unknown>>>> {
  session: SessionContext<R>;
  reason: SessionEndReason;
}

/** Context passed to `onAgentMessage` (stub — not wired for MVP). */
export interface AgentMessageContext<R extends Record<string, Runtime<Record<string, unknown>>>> {
  session: SessionContext<R>;
  type: string;
  data: unknown;
}

/** Context passed to `onError` (stub — not wired for MVP). */
export interface ErrorContext<R extends Record<string, Runtime<Record<string, unknown>>>> {
  session: SessionContext<R>;
  error: Error;
}

/** Event handlers that can be registered on a Flamecast instance. */
export interface FlamecastEventHandlers<
  R extends Record<string, Runtime<Record<string, unknown>>>,
> {
  onPermissionRequest?: (c: PermissionRequestContext<R>) => Promise<PermissionResponse | undefined>;
  onSessionEnd?: (c: SessionEndContext<R>) => Promise<void>;
  onAgentMessage?: (c: AgentMessageContext<R>) => Promise<void>;
  onError?: (c: ErrorContext<R>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// FlamecastOptions & Flamecast class
// ---------------------------------------------------------------------------

export type FlamecastOptions<
  R extends Record<string, Runtime<Record<string, unknown>>> = Record<string, Runtime>,
> = {
  storage?: FlamecastStorage;
  runtimes: R;
  agentTemplates?: AgentTemplate[];
  /** Override the auto-detected callback URL for session-host → control plane events. */
  callbackUrl?: string;
  /** Global webhooks delivered for all sessions. Merged with per-session webhooks at creation time. */
  webhooks?: Omit<WebhookConfig, "id">[];
} & FlamecastEventHandlers<R>;

export class Flamecast<
  R extends Record<string, Runtime<Record<string, unknown>>> = Record<string, Runtime>,
> {
  private readonly initialAgentTemplates: AgentTemplate[] | undefined;
  private readonly storageConfig?: FlamecastStorage;
  private readonly sessionService: SessionService;
  private readonly runtimesMap: Record<string, Runtime<Record<string, unknown>>>;
  private readonly callbackUrl?: string;
  private readonly globalWebhooks: Omit<WebhookConfig, "id">[];
  private readonly webhookEngine = new WebhookDeliveryEngine();
  private readonly webhookAbortControllers = new Map<string, AbortController>();

  /** Event bus for lifecycle events and session history. */
  readonly eventBus = new EventBus();

  /** Registered event handlers. */
  readonly handlers: Readonly<FlamecastEventHandlers<R>>;

  private storage: FlamecastStorage | null = null;
  private readyPromise: Promise<void> | null = null;
  private recoveryPromise: Promise<void> | null = null;

  /** The Hono app. Use with any runtime: Node, CF Workers, Vercel, etc. */
  readonly app;

  constructor(opts: FlamecastOptions<R>) {
    this.storageConfig = opts.storage;
    this.initialAgentTemplates = opts.agentTemplates;
    this.callbackUrl = opts.callbackUrl;
    this.globalWebhooks = opts.webhooks ?? [];
    this.runtimesMap = opts.runtimes;
    this.sessionService = new SessionService(opts.runtimes);
    this.app = createServerApp(this);
    this.handlers = {
      onPermissionRequest: opts.onPermissionRequest,
      onSessionEnd: opts.onSessionEnd,
      onAgentMessage: opts.onAgentMessage,
      onError: opts.onError,
    };
  }

  /** Names of registered runtimes (used for API validation). */
  get runtimeNames(): string[] {
    return Object.keys(this.runtimesMap);
  }

  /**
   * Graceful close — tears down in-process resources (webhook retries, event
   * bus) without terminating running sessions or disposing runtimes.
   *
   * Use this for server restarts: sessions and their host processes/containers
   * stay alive and will be recovered via `recoverSessions()` on the next start.
   */
  async close(): Promise<void> {
    for (const ac of this.webhookAbortControllers.values()) ac.abort();
    this.webhookAbortControllers.clear();
    this.webhookEngine.clear();
  }

  /**
   * Hard shutdown — terminates all sessions, kills all containers/processes,
   * and disposes all runtimes. Sessions will NOT be recoverable after this.
   */
  async shutdown(): Promise<void> {
    for (const id of this.sessionService.listSessionIds()) {
      await this.terminateSession(id).catch(() => {});
    }
    await this.close();
    for (const runtime of Object.values(this.runtimesMap)) {
      await runtime.dispose?.();
    }
  }

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    await this.ensureReady();
    return this.requireStorage().listAgentTemplates();
  }

  async updateAgentTemplate(
    id: string,
    patch: {
      name?: string;
      spawn?: AgentTemplate["spawn"];
      runtime?: Partial<AgentTemplate["runtime"]>;
      env?: Record<string, string>;
    },
  ): Promise<AgentTemplate> {
    await this.ensureReady();
    const updated = await this.requireStorage().updateAgentTemplate(id, patch);
    if (!updated) throw new Error(`Agent template "${id}" not found`);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Runtime lifecycle
  // ---------------------------------------------------------------------------

  async listRuntimes(): Promise<RuntimeInfo[]> {
    await this.ensureReady();
    const storage = this.requireStorage();
    const instances = await storage.listRuntimeInstances();

    // Resolve live status for instances whose runtime supports it
    const resolvedInstances: RuntimeInstance[] = [];
    for (const inst of instances) {
      const runtime = this.runtimesMap[inst.typeName];
      let status = inst.status;

      if (runtime?.getInstanceStatus) {
        const liveStatus = await runtime.getInstanceStatus(inst.name).catch(() => undefined);
        if (liveStatus) {
          status = liveStatus;
        } else if (inst.status === "running" || inst.status === "paused") {
          // Runtime has no knowledge of this instance (e.g. server restarted) — mark stopped
          status = "stopped";
        }
        // Sync DB if it drifted (e.g. someone paused via Docker Desktop, or server restarted)
        if (status !== inst.status) {
          await storage.saveRuntimeInstance({ ...inst, status }).catch(() => {});
        }
      }

      resolvedInstances.push({ ...inst, status });
    }

    const instancesByType = new Map<string, RuntimeInstance[]>();
    for (const inst of resolvedInstances) {
      const list = instancesByType.get(inst.typeName) ?? [];
      list.push(inst);
      instancesByType.set(inst.typeName, list);
    }

    return Object.entries(this.runtimesMap).map(([typeName, runtime]) => ({
      typeName,
      onlyOne: runtime.onlyOne ?? false,
      instances: instancesByType.get(typeName) ?? [],
    }));
  }

  async startRuntime(typeName: string, instanceName?: string): Promise<RuntimeInstance> {
    await this.ensureReady();
    const runtime = this.runtimesMap[typeName];
    if (!runtime) {
      throw new Error(
        `Unknown runtime type: "${typeName}". Available: ${this.runtimeNames.join(", ")}`,
      );
    }

    const name = instanceName ?? typeName;

    if (runtime.onlyOne && name !== typeName) {
      throw new Error(`Runtime "${typeName}" only supports a single instance`);
    }

    if (runtime.start) {
      await runtime.start(name);
    }

    const instance: RuntimeInstance = { name, typeName, status: "running" };
    await this.requireStorage().saveRuntimeInstance(instance);
    return instance;
  }

  async stopRuntime(instanceName: string): Promise<void> {
    await this.ensureReady();
    const storage = this.requireStorage();
    const instances = await storage.listRuntimeInstances();
    const instance = instances.find((i) => i.name === instanceName);
    if (!instance) {
      throw new Error(`Runtime instance "${instanceName}" not found`);
    }

    // Terminate all active sessions on this instance
    const allSessions = await storage.listAllSessions();
    for (const session of allSessions) {
      if (session.status === "active" && session.runtime === instanceName) {
        await this.terminateSession(session.id).catch(() => {});
      }
    }

    const runtime = this.runtimesMap[instance.typeName];
    if (runtime?.stop) {
      await runtime.stop(instanceName);
    }

    await storage.saveRuntimeInstance({ ...instance, status: "stopped" });
  }

  async pauseRuntime(instanceName: string): Promise<void> {
    await this.ensureReady();
    const storage = this.requireStorage();
    const instances = await storage.listRuntimeInstances();
    const instance = instances.find((i) => i.name === instanceName);
    if (!instance) {
      throw new Error(`Runtime instance "${instanceName}" not found`);
    }

    const runtime = this.runtimesMap[instance.typeName];
    if (!runtime?.pause) {
      throw new Error(`Runtime "${instance.typeName}" does not support pause`);
    }

    await runtime.pause(instanceName);
    await storage.saveRuntimeInstance({ ...instance, status: "paused" });
  }

  async registerAgentTemplate(
    body: Omit<RegisterAgentTemplateBody, "runtime"> & {
      runtime?: { provider?: RuntimeNames<R> | string } & Record<string, unknown>;
    },
  ): Promise<AgentTemplate> {
    await this.ensureReady();

    const provider = body.runtime?.provider ?? this.runtimeNames[0] ?? "default";

    // Validate provider against registered runtimes
    if (!this.runtimesMap[provider]) {
      throw new Error(`Unknown runtime: "${provider}". Available: ${this.runtimeNames.join(", ")}`);
    }

    const template: AgentTemplate = {
      id: randomUUID(),
      name: body.name,
      spawn: {
        command: body.spawn.command,
        args: [...body.spawn.args],
      },
      runtime: body.runtime ? { ...body.runtime, provider } : { provider },
      ...(body.env ? { env: body.env } : {}),
    };

    await this.requireStorage().saveAgentTemplate(template);
    return template;
  }

  async createSession(
    opts: CreateSessionBody,
    internal?: { callbackUrl?: string },
  ): Promise<Session> {
    await this.ensureReady();

    const cwd = opts.cwd ?? process.cwd();
    const { agentName, spawn, runtime } = await this.resolveSessionDefinition(opts);
    const startedAt = new Date().toISOString();
    const callbackUrl = internal?.callbackUrl ?? this.callbackUrl;

    // Merge global + per-session webhooks, assign stable IDs
    const sessionWebhooks: WebhookConfig[] = [...this.globalWebhooks, ...(opts.webhooks ?? [])].map(
      (w) => ({ ...w, id: randomUUID() }),
    );

    // Resolve the runtime instance name. For onlyOne runtimes, instance = type name.
    // For multi-instance runtimes, use the explicitly provided instance or fall back to type name.
    const runtimeObj = this.runtimesMap[runtime.provider];
    const runtimeInstance = runtimeObj?.onlyOne
      ? runtime.provider
      : (opts.runtimeInstance ?? runtime.provider);

    const { sessionId } = await this.sessionService.startSession(this.requireStorage(), {
      agentName,
      spawn,
      cwd,
      runtime,
      runtimeInstance,
      startedAt,
      callbackUrl,
      webhooks: sessionWebhooks,
    });

    this.eventBus.emitSessionCreated({
      sessionId,
      agentId: resolveAgentId(sessionId),
    });

    return this.snapshotSession(sessionId);
  }

  async listSessions(): Promise<Session[]> {
    await this.ensureReady();
    const allMetas = await this.requireStorage().listAllSessions();
    const activeMetas = allMetas.filter((meta) => meta.status === "active");
    return Promise.all(activeMetas.map((meta) => this.snapshotSession(meta.id)));
  }

  async getSession(
    id: string,
    opts: { includeFileSystem?: boolean; showAllFiles?: boolean } = {},
  ): Promise<Session> {
    await this.ensureReady();
    if (!this.sessionService.hasSession(id)) {
      const meta = await this.requireStorage().getSessionMeta(id);
      if (!meta) throw new Error(`Session "${id}" not found`);
    }
    return this.snapshotSession(id, { ...opts, includeLogs: true });
  }

  /** Proxy a queue management request to the session-host. */
  async proxyQueueRequest(id: string, path: string, init: RequestInit): Promise<Response> {
    await this.ensureReady();
    return this.sessionService.proxyRequest(id, path, init);
  }

  async fetchRuntimeFilePreview(instanceName: string, path: string): Promise<FilePreview> {
    await this.ensureReady();
    const response = await this.proxyRuntimeInstanceRequest(
      instanceName,
      `/files?path=${encodeURIComponent(path)}`,
      { method: "GET" },
    );
    if (!response.ok) {
      const detail = await readProxyErrorDetail(response);
      throw new ProxyRequestError(response.status, detail);
    }
    const preview: FilePreview = await response.json();
    return preview;
  }

  async fetchRuntimeFileSystem(
    instanceName: string,
    opts: { showAllFiles?: boolean } = {},
  ): Promise<FileSystemSnapshot> {
    await this.ensureReady();
    const query = opts.showAllFiles ? "?showAllFiles=true" : "";
    const response = await this.proxyRuntimeInstanceRequest(instanceName, `/fs/snapshot${query}`, {
      method: "GET",
    });
    if (!response.ok) {
      const detail = await readProxyErrorDetail(response);
      throw new ProxyRequestError(response.status, detail);
    }
    const snapshot: FileSystemSnapshot = await response.json();
    return snapshot;
  }

  async fetchSessionFilePreview(id: string, path: string): Promise<FilePreview> {
    await this.ensureReady();
    const response = await this.sessionService.proxyRequest(
      id,
      `/files?path=${encodeURIComponent(path)}`,
      { method: "GET" },
    );
    if (!response.ok) {
      const detail = await readProxyErrorDetail(response);
      throw new ProxyRequestError(response.status, detail);
    }
    const preview: FilePreview = await response.json();
    return preview;
  }

  async fetchSessionFileSystem(
    id: string,
    opts: { showAllFiles?: boolean } = {},
  ): Promise<FileSystemSnapshot> {
    await this.ensureReady();
    const query = opts.showAllFiles ? "?showAllFiles=true" : "";
    const response = await this.sessionService.proxyRequest(id, `/fs/snapshot${query}`, {
      method: "GET",
    });
    if (!response.ok) {
      const detail = await readProxyErrorDetail(response);
      throw new ProxyRequestError(response.status, detail);
    }
    const snapshot: FileSystemSnapshot = await response.json();
    return snapshot;
  }

  async promptSession(id: string, text: string): Promise<Record<string, unknown>> {
    await this.ensureReady();
    const response = await this.sessionService.proxyRequest(id, "/prompt", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "(unreadable)");
      throw new Error(`Prompt failed (${response.status}): ${detail}`);
    }
    return response.json();
  }

  async resolvePermission(
    sessionId: string,
    requestId: string,
    body: { optionId: string } | { outcome: "cancelled" },
  ): Promise<Record<string, unknown>> {
    await this.ensureReady();
    const response = await this.sessionService.proxyRequest(
      sessionId,
      `/permissions/${requestId}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "(unreadable)");
      throw new Error(`Permission resolve failed (${response.status}): ${detail}`);
    }

    // The session host's HTTP permission endpoint does not emit a resolution
    // event back through the callback, so push one to the event bus so that
    // WS clients can track which permissions have been resolved.
    const eventType =
      "outcome" in body && body.outcome === "cancelled"
        ? "permission_cancelled"
        : "permission_responded";
    this.eventBus.pushEvent({
      sessionId,
      agentId: resolveAgentId(sessionId),
      event: {
        type: eventType,
        data: { requestId, ...body },
        timestamp: new Date().toISOString(),
      },
    });

    return response.json();
  }

  async terminateSession(id: string): Promise<void> {
    await this.ensureReady();
    if (!this.sessionService.hasSession(id)) {
      const meta = await this.requireStorage().getSessionMeta(id);
      if (meta?.status === "killed") {
        throw new Error("Cannot terminate an already-killed session");
      }
    }

    // Build session context for the handler before termination
    const sessionCtx = await this.buildSessionContext(id);

    await this.sessionService.terminateSession(this.requireStorage(), id);

    // Emit lifecycle event for in-process subscribers such as SSE streams.
    this.eventBus.emitSessionTerminated({
      sessionId: id,
      agentId: resolveAgentId(id),
    });

    // Cancel in-flight webhook retries for this session
    this.webhookAbortControllers.get(id)?.abort();
    this.webhookAbortControllers.delete(id);

    // Invoke onSessionEnd handler if registered
    if (this.handlers.onSessionEnd && sessionCtx) {
      try {
        await this.handlers.onSessionEnd({ session: sessionCtx, reason: "terminated" });
      } catch (err) {
        console.warn(
          `[Flamecast] onSessionEnd handler error for "${id}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * Handle an event callback from the session-host.
   * Dispatches to the appropriate handler based on event type.
   */
  async handleSessionEvent(
    sessionId: string,
    event: SessionCallbackEvent,
  ): Promise<PermissionCallbackResponse | { ok: true }> {
    // 1. Dispatch to in-process handler
    let result: PermissionCallbackResponse | { ok: true };

    switch (event.type) {
      case "permission_request": {
        const permResponse = await this.handlePermissionRequest(sessionId, event.data);
        result = permResponse ?? { deferred: true };
        break;
      }

      case "end_turn": {
        // REST-prompt end_turn — delivered to webhooks only (no in-process handler yet)
        result = { ok: true };
        break;
      }

      case "session_end": {
        const ctx = await this.buildSessionContext(sessionId);
        if (this.handlers.onSessionEnd && ctx) {
          try {
            await this.handlers.onSessionEnd({ session: ctx, reason: "agent_exit" });
          } catch (err) {
            console.warn(
              `[Flamecast] onSessionEnd handler error:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
        result = { ok: true };
        break;
      }

      case "agent_message": {
        const ctx = await this.buildSessionContext(sessionId);
        if (this.handlers.onAgentMessage && ctx) {
          try {
            await this.handlers.onAgentMessage({
              session: ctx,
              type: "agent_message",
              data: event.data.sessionUpdate,
            });
          } catch (err) {
            console.warn(
              `[Flamecast] onAgentMessage handler error:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
        result = { ok: true };
        break;
      }

      case "error": {
        const ctx = await this.buildSessionContext(sessionId);
        if (this.handlers.onError && ctx) {
          try {
            await this.handlers.onError({
              session: ctx,
              error: new Error(event.data.message),
            });
          } catch (err) {
            console.warn(
              `[Flamecast] onError handler error:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
        result = { ok: true };
        break;
      }

      default:
        result = { ok: true };
    }

    // 2. Push to the in-process history stream used by session snapshots and
    //    SSE consumers. Runtime WebSocket clients connect directly to the
    //    runtime, so there is no bridge layer deduplicating these events.
    this.eventBus.pushEvent({
      sessionId,
      agentId: resolveAgentId(sessionId),
      event: {
        type: event.type,
        data: { ...event.data },
        timestamp: new Date().toISOString(),
      },
    });

    // 3. Deliver to external webhooks (fire-and-forget, does not block response)
    this.deliverWebhooks(sessionId, event);

    return result;
  }

  /** Event types that are delivered via external webhooks. */
  private static readonly WEBHOOK_EVENT_TYPES: Set<string> = new Set<WebhookEventType>([
    "permission_request",
    "session_end",
    "end_turn",
    "error",
  ]);

  /** Fire-and-forget webhook delivery for a session event. */
  private deliverWebhooks(sessionId: string, event: SessionCallbackEvent): void {
    if (!Flamecast.WEBHOOK_EVENT_TYPES.has(event.type)) return;

    const webhooks = this.sessionService.getWebhooks(sessionId);
    if (webhooks.length === 0) return;

    let ac = this.webhookAbortControllers.get(sessionId);
    if (!ac) {
      ac = new AbortController();
      this.webhookAbortControllers.set(sessionId, ac);
    }

    void this.webhookEngine.deliver(
      sessionId,
      event.type,
      JSON.parse(JSON.stringify(event.data)),
      webhooks,
      ac.signal,
    );
  }

  /**
   * Invoke the `onPermissionRequest` handler for a given session.
   *
   * Called by SessionService when a permission event arrives from the session
   * host (deployed mode only — see PermissionRequestContext doc for limitations).
   *
   * Returns the handler's response, or `undefined` if no handler is registered.
   */
  async handlePermissionRequest(
    sessionId: string,
    event: {
      requestId: string;
      toolCallId: string;
      title: string;
      kind?: string;
      options: Array<{ optionId: string; name: string; kind: string }>;
    },
  ): Promise<PermissionResponse | undefined> {
    if (!this.handlers.onPermissionRequest) return undefined;

    const sessionCtx = await this.buildSessionContext(sessionId);
    if (!sessionCtx) return undefined;

    const ctx: PermissionRequestContext<R> = {
      session: sessionCtx,
      requestId: event.requestId,
      toolCallId: event.toolCallId,
      title: event.title,
      kind: event.kind,
      options: event.options,
      allow() {
        const approveOpt = event.options.find((o) => o.kind.startsWith("allow"));
        return approveOpt ? { optionId: approveOpt.optionId } : { outcome: "cancelled" };
      },
      deny() {
        const rejectOpt = event.options.find((o) => o.kind.startsWith("reject"));
        return rejectOpt ? { optionId: rejectOpt.optionId } : { outcome: "cancelled" };
      },
    };

    try {
      return await this.handlers.onPermissionRequest(ctx);
    } catch (err) {
      console.warn(
        `[Flamecast] onPermissionRequest handler error for "${sessionId}":`,
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async buildSessionContext(sessionId: string): Promise<SessionContext<R> | null> {
    const storage = this.requireStorage();
    const meta = await storage.getSessionMeta(sessionId);
    if (!meta) return null;

    // Determine which runtime provider this session uses. SessionService
    // tracks this internally, but the meta doesn't persist the runtime name.
    // Fallback to "unknown" if the session is already removed from the service.
    const runtimeName = this.sessionService.getRuntimeName(sessionId) ?? "unknown";

    return {
      id: meta.id,
      agentName: meta.agentName,
      // oxlint-disable-next-line no-type-assertion/no-type-assertion -- generic boundary: TS can't narrow string to keyof R
      runtime: runtimeName as RuntimeNames<R>,
      spawn: { command: meta.spawn.command, args: [...meta.spawn.args] },
      startedAt: meta.startedAt,
    };
  }

  /**
   * Recover active sessions from storage after a server restart.
   *
   * For each session that was marked "active" in the database, attempts to
   * reconnect to the still-running process/container. Sessions whose hosts
   * are no longer alive are marked as killed.
   *
   * Returns the list of successfully recovered session IDs and their runtime
   * websocket URLs.
   */
  async recoverSessions(
    onRecovered?: (sessions: Array<{ sessionId: string; websocketUrl: string }>) => void,
  ): Promise<Array<{ sessionId: string; websocketUrl: string }>> {
    const doRecover = async (): Promise<Array<{ sessionId: string; websocketUrl: string }>> => {
      // Initialize storage directly to avoid circular await (ensureReady waits on recovery).
      // Also set readyPromise so ensureReady() skips re-initialization later.
      if (!this.readyPromise) {
        this.readyPromise = (async () => {
          const storage = this.storageConfig ?? new MemoryFlamecastStorage();
          this.storage = storage;
          if (this.initialAgentTemplates) {
            await storage.seedAgentTemplates(this.initialAgentTemplates);
          }
        })();
      }
      await this.readyPromise;
      const storage = this.requireStorage();
      const activeSessions = await storage.listActiveSessionsWithRuntime();

      const recovered: Array<{ sessionId: string; websocketUrl: string }> = [];

      for (const session of activeSessions) {
        if (!session.runtimeInfo) {
          await storage.finalizeSession(session.id, "terminated");
          continue;
        }

        const ok = await this.sessionService.recoverSession(session.id, session.runtimeInfo);
        if (ok) {
          recovered.push({
            sessionId: session.id,
            websocketUrl: session.runtimeInfo.websocketUrl,
          });
          console.log(`[Flamecast] Recovered session "${session.id}"`);
        } else {
          await storage.finalizeSession(session.id, "terminated");
          console.log(`[Flamecast] Session "${session.id}" no longer alive, marked as killed`);
        }
      }

      // Let the caller observe recovered sessions before the promise resolves.
      onRecovered?.(recovered);

      return recovered;
    };
    const promise = doRecover();
    this.recoveryPromise = promise.then(() => {});
    return promise;
  }

  private async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const storage = this.storageConfig ?? new MemoryFlamecastStorage();
        this.storage = storage;
        if (this.initialAgentTemplates) {
          await storage.seedAgentTemplates(this.initialAgentTemplates);
        }
      })();
    }
    await this.readyPromise;
    if (this.recoveryPromise) {
      await this.recoveryPromise;
    }
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

      // Merge env: runtime-level env as base, template-level env as override
      const mergedEnv =
        template.runtime.env || template.env
          ? { ...template.runtime.env, ...template.env }
          : undefined;

      return {
        agentName: template.name,
        spawn: {
          command: template.spawn.command,
          args: [...template.spawn.args],
        },
        runtime: { ...template.runtime, ...(mergedEnv ? { env: mergedEnv } : {}) },
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
      runtime: { provider: "local" },
    };
  }

  private async snapshotSession(
    id: string,
    opts: { includeFileSystem?: boolean; includeLogs?: boolean; showAllFiles?: boolean } = {},
  ): Promise<Session> {
    const storage = this.requireStorage();
    const meta = await storage.getSessionMeta(id);
    if (!meta) {
      throw new Error(`Session "${id}" not found`);
    }

    const websocketUrl = this.sessionService.getWebsocketUrl(id);

    // Fetch queue state from session-host if the session is active
    const promptQueue = this.sessionService.hasSession(id)
      ? await this.sessionService
          .proxyRequest(id, "/queue", { method: "GET" })
          .then((r) => (r.ok ? r.json().catch(() => null) : null))
          .catch(() => null)
      : null;

    const logs: SessionLog[] = opts.includeLogs
      ? this.eventBus.getHistory(id).map(({ event }) => ({
          type: event.type,
          data: structuredClone(event.data),
          timestamp: event.timestamp,
        }))
      : [];

    const fileSystem =
      opts.includeFileSystem && this.sessionService.hasSession(id)
        ? await this.fetchSessionFileSystem(id, { showAllFiles: opts.showAllFiles }).catch(
            () => null,
          )
        : null;

    return {
      ...meta,
      logs,
      pendingPermission: meta.pendingPermission
        ? {
            ...meta.pendingPermission,
            options: meta.pendingPermission.options.map((option) => ({ ...option })),
          }
        : null,
      fileSystem,
      promptQueue,
      websocketUrl,
      runtime: meta.runtime,
    };
  }

  private async proxyRuntimeInstanceRequest(
    instanceName: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const storage = this.requireStorage();
    const instances = await storage.listRuntimeInstances();
    const instance = instances.find((candidate) => candidate.name === instanceName);

    const typeName = instance?.typeName ?? instanceName;
    const runtime = this.runtimesMap[typeName];
    if (!runtime) {
      return new Response("Runtime instance not found", { status: 404 });
    }
    if (!runtime.fetchInstance) {
      return new Response("Runtime instance proxy is not supported", { status: 400 });
    }

    return runtime.fetchInstance(
      instanceName,
      new Request(`http://runtime${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...init.headers },
      }),
    );
  }
}
