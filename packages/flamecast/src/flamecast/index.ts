import { randomUUID } from "node:crypto";
import type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  CreateSessionBody,
  RegisterAgentTemplateBody,
  Session,
  WebhookConfig,
  WebhookEventType,
} from "../shared/session.js";
import { createServerApp } from "../server/app.js";
import type { FlamecastStorage } from "./storage.js";
import { MemoryFlamecastStorage } from "./storage/memory/index.js";
import { SessionService } from "./session-service.js";
import { WebhookDeliveryEngine } from "./webhook-delivery.js";
import type {
  SessionCallbackEvent,
  PermissionCallbackResponse,
} from "@flamecast/protocol/session-host";
import type {
  Runtime,
  RuntimeNames,
  SessionContext,
  SessionEndReason,
} from "@flamecast/protocol/runtime";

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

export type { SessionMeta, FlamecastStorage } from "./storage.js";
export { NodeRuntime } from "./runtimes/node.js";

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

  /** Registered event handlers. */
  readonly handlers: Readonly<FlamecastEventHandlers<R>>;

  private storage: FlamecastStorage | null = null;
  private readyPromise: Promise<void> | null = null;

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

  /** Terminate all sessions and dispose all runtimes. */
  async shutdown(): Promise<void> {
    for (const id of this.sessionService.listSessionIds()) {
      await this.terminateSession(id).catch(() => {});
    }
    // Cancel any remaining webhook retries
    for (const ac of this.webhookAbortControllers.values()) ac.abort();
    this.webhookAbortControllers.clear();
    this.webhookEngine.clear();

    for (const runtime of Object.values(this.runtimesMap)) {
      await runtime.dispose?.();
    }
  }

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    await this.ensureReady();
    return this.requireStorage().listAgentTemplates();
  }

  async registerAgentTemplate(
    body: RegisterAgentTemplateBody & {
      runtime?: { provider: RuntimeNames<R> } & Record<string, unknown>;
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
      runtime: body.runtime ? { ...body.runtime } : { provider },
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

    const { sessionId } = await this.sessionService.startSession(this.requireStorage(), {
      agentName,
      spawn,
      cwd,
      runtime,
      startedAt,
      callbackUrl,
      webhooks: sessionWebhooks,
    });

    return this.snapshotSession(sessionId);
  }

  async listSessions(): Promise<Session[]> {
    await this.ensureReady();
    const allMetas = await this.requireStorage().listAllSessions();
    return Promise.all(allMetas.map((meta) => this.snapshotSession(meta.id)));
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
    return this.snapshotSession(id, opts);
  }

  /** Proxy a queue management request to the session-host. */
  async proxyQueueRequest(id: string, path: string, init: RequestInit): Promise<Response> {
    return this.sessionService.proxyRequest(id, path, init);
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

    // 2. Deliver to external webhooks (fire-and-forget, does not block response)
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

  private async ensureReady(): Promise<void> {
    if (this.storage) return;
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
      runtime: { provider: "local" },
    };
  }

  private async snapshotSession(
    id: string,
    _opts: { includeFileSystem?: boolean; showAllFiles?: boolean } = {},
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

    return {
      ...meta,
      logs: [],
      pendingPermission: meta.pendingPermission
        ? {
            ...meta.pendingPermission,
            options: meta.pendingPermission.options.map((option) => ({ ...option })),
          }
        : null,
      fileSystem: null,
      promptQueue,
      websocketUrl,
    };
  }
}
