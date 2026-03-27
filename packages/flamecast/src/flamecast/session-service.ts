import type { AgentSpawn, AgentTemplateRuntime, WebhookConfig } from "../shared/session.js";
import type { FlamecastStorage, SessionRuntimeInfo } from "./storage.js";
import type {
  Runtime,
  SessionHostStartRequest,
  SessionHostStartResponse,
} from "@flamecast/protocol";

interface ManagedSession {
  id: string;
  hostUrl: string;
  websocketUrl: string;
  runtimeName: string;
  webhooks: WebhookConfig[];
}

export class SessionService {
  private readonly runtimes: Record<string, Runtime<Record<string, unknown>>>;
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(runtimes: Record<string, Runtime<Record<string, unknown>>>) {
    this.runtimes = runtimes;
  }

  async startSession(
    storage: FlamecastStorage,
    opts: {
      agentName: string;
      spawn: AgentSpawn;
      cwd: string;
      runtime: AgentTemplateRuntime;
      runtimeInstance?: string;
      startedAt: string;
      callbackUrl?: string;
      webhooks?: WebhookConfig[];
    },
  ): Promise<{ sessionId: string }> {
    const providerName = opts.runtime.provider ?? "local";
    const runtime = this.runtimes[providerName];
    if (!runtime) {
      throw new Error(
        `Unknown runtime: "${providerName}". Available: ${Object.keys(this.runtimes).join(", ")}`,
      );
    }

    const sessionId = crypto.randomUUID();
    const body = {
      sessionId,
      command: opts.spawn.command,
      args: opts.spawn.args ?? [],
      workspace: opts.cwd,
      setup: opts.runtime.setup,
      env: opts.runtime.env,
      callbackUrl: opts.callbackUrl,
      instanceName: opts.runtimeInstance,
    } satisfies SessionHostStartRequest & Record<string, unknown>;

    let response: Response;
    try {
      response = await runtime.fetchSession(
        sessionId,
        new Request("http://host/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    } catch (error) {
      throw new Error(
        `SessionHost failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "(unreadable body)");
      throw new Error(`SessionHost /start failed (${response.status}): ${detail}`);
    }

    const result: SessionHostStartResponse = await response.json();
    const runtimeMeta = runtime.getRuntimeMeta?.(sessionId) ?? null;

    const runtimeInfo: SessionRuntimeInfo = {
      hostUrl: result.hostUrl,
      websocketUrl: result.websocketUrl,
      runtimeName: providerName,
      runtimeMeta,
    };

    try {
      await storage.createSession(
        {
          id: sessionId,
          agentName: opts.agentName,
          spawn: opts.spawn,
          startedAt: opts.startedAt,
          lastUpdatedAt: new Date().toISOString(),
          status: "active",
          pendingPermission: null,
          runtime: opts.runtimeInstance ?? providerName,
        },
        runtimeInfo,
      );
    } catch (storageError) {
      // Session host is running but storage failed — attempt to terminate the host.
      try {
        await runtime.fetchSession(
          sessionId,
          new Request("http://host/terminate", { method: "POST" }),
        );
      } catch {
        // Best-effort cleanup; host may leak but we must surface the original error.
      }
      throw new Error(
        `Failed to persist session: ${storageError instanceof Error ? storageError.message : String(storageError)}`,
      );
    }

    this.sessions.set(sessionId, {
      id: sessionId,
      hostUrl: result.hostUrl,
      websocketUrl: result.websocketUrl,
      runtimeName: providerName,
      webhooks: opts.webhooks ?? [],
    });

    return { sessionId };
  }

  /**
   * Attempt to recover a previously-active session after a server restart.
   * Verifies that the session-host process is still alive before re-registering.
   * Returns `true` if the session was successfully recovered.
   */
  async recoverSession(sessionId: string, runtimeInfo: SessionRuntimeInfo): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true;

    const runtime = this.runtimes[runtimeInfo.runtimeName];
    if (!runtime) return false;

    // Try runtime-specific reconnection first (re-populates internal tracking)
    let alive = false;
    if (runtime.reconnect) {
      alive = await runtime
        .reconnect(sessionId, runtimeInfo.runtimeMeta ?? null)
        .catch(() => false);
    }

    // Fall back to a health-check probe against the persisted hostUrl
    if (!alive) {
      try {
        const resp = await fetch(`${runtimeInfo.hostUrl}/health`);
        alive = resp.ok;
      } catch {
        alive = false;
      }
    }

    if (!alive) return false;

    this.sessions.set(sessionId, {
      id: sessionId,
      hostUrl: runtimeInfo.hostUrl,
      websocketUrl: runtimeInfo.websocketUrl,
      runtimeName: runtimeInfo.runtimeName,
      webhooks: [],
    });

    return true;
  }

  async terminateSession(storage: FlamecastStorage, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    const runtime = this.runtimes[session.runtimeName];
    if (runtime) {
      try {
        const response = await runtime.fetchSession(
          sessionId,
          new Request("http://host/terminate", { method: "POST" }),
        );
        if (!response.ok) {
          console.warn(
            `[SessionService] terminate call for "${sessionId}" returned ${response.status}: ${await response.text().catch(() => "(unreadable)")}`,
          );
        }
      } catch (error) {
        // Log but proceed with cleanup — the session host may already be gone.
        console.warn(
          `[SessionService] terminate call for "${sessionId}" failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    await storage.finalizeSession(sessionId, "terminated");
    this.sessions.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  listSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  getWebsocketUrl(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.websocketUrl;
  }

  getRuntimeName(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.runtimeName;
  }

  getWebhooks(sessionId: string): WebhookConfig[] {
    return this.sessions.get(sessionId)?.webhooks ?? [];
  }

  async proxyRequest(sessionId: string, path: string, init: RequestInit): Promise<Response> {
    const session = this.sessions.get(sessionId);
    if (!session) return new Response("Session not found", { status: 404 });
    const runtime = this.runtimes[session.runtimeName];
    if (!runtime) return new Response("Runtime not found", { status: 500 });
    return runtime.fetchSession(
      sessionId,
      new Request(`http://host${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...init.headers },
      }),
    );
  }

  async proxyWebSocket(sessionId: string, request: Request): Promise<Response> {
    const session = this.sessions.get(sessionId);
    if (!session) return new Response("Session not found", { status: 404 });
    const runtime = this.runtimes[session.runtimeName];
    if (!runtime) return new Response("Runtime not found", { status: 500 });
    return runtime.fetchSession(sessionId, request);
  }
}
