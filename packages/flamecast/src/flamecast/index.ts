import { randomUUID } from "node:crypto";
import type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  CreateSessionBody,
  RegisterAgentTemplateBody,
  Session,
} from "../shared/session.js";
import { createServerApp } from "../server/app.js";
import type { FlamecastStorage } from "./storage.js";
import { MemoryFlamecastStorage } from "./storage/memory/index.js";
import { SessionService } from "./session-service.js";
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
 * NOTE (MVP limitation): `onPermissionRequest` is only invoked when the
 * control plane sits in the WebSocket proxy path (deployed mode). In local-dev
 * mode (direct WS between UI and session host), the permission request goes
 * straight to the UI and this handler is not called.
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
  /** Stub — not wired for MVP. */
  onAgentMessage?: (c: AgentMessageContext<R>) => Promise<void>;
  /** Stub — not wired for MVP. */
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
} & FlamecastEventHandlers<R>;

export class Flamecast<
  R extends Record<string, Runtime<Record<string, unknown>>> = Record<string, Runtime>,
> {
  private readonly initialAgentTemplates: AgentTemplate[] | undefined;
  private readonly storageConfig?: FlamecastStorage;
  private readonly sessionService: SessionService;
  private readonly runtimesMap: Record<string, Runtime<Record<string, unknown>>>;

  /** Registered event handlers. */
  readonly handlers: Readonly<FlamecastEventHandlers<R>>;

  private storage: FlamecastStorage | null = null;
  private readyPromise: Promise<void> | null = null;

  /** The Hono app. Use with any runtime: Node, CF Workers, Vercel, etc. */
  readonly app;

  constructor(opts: FlamecastOptions<R>) {
    this.storageConfig = opts.storage;
    this.initialAgentTemplates = opts.agentTemplates;
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

  async createSession(opts: CreateSessionBody): Promise<Session> {
    await this.ensureReady();

    const cwd = opts.cwd ?? process.cwd();
    const { agentName, spawn, runtime } = await this.resolveSessionDefinition(opts);
    const startedAt = new Date().toISOString();

    const { sessionId } = await this.sessionService.startSession(this.requireStorage(), {
      agentName,
      spawn,
      cwd,
      runtime,
      startedAt,
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
      promptQueue: null,
      websocketUrl,
    };
  }
}
