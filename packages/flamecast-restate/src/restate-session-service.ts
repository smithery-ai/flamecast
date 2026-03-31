import type { ISessionService } from "@flamecast/sdk";
import type { WebhookConfig } from "@flamecast/protocol/session";
import type { FlamecastStorage, SessionRuntimeInfo } from "@flamecast/sdk";
import type { Runtime } from "@flamecast/protocol/runtime";
import * as clients from "@restatedev/restate-sdk-clients";
import { FlamecastSession } from "./session-object.js";

/**
 * RestateSessionService — ISessionService backed by Restate Virtual Objects.
 *
 * Each session is a keyed Virtual Object with durable state, automatic
 * concurrency control, and journal-based recovery. The service delegates
 * lifecycle operations to the FlamecastSession VO and proxies runtime
 * requests via cached hostUrl.
 */
export class RestateSessionService implements ISessionService {
  private readonly restateClient: clients.Ingress;
  private readonly restateUrl: string;
  private readonly runtimes: Record<string, Runtime<Record<string, unknown>>>;
  private readonly hostUrlCache = new Map<string, string>();

  constructor(
    runtimes: Record<string, Runtime<Record<string, unknown>>>,
    restateUrl: string,
  ) {
    this.runtimes = runtimes;
    this.restateUrl = restateUrl;
    this.restateClient = clients.connect({ url: restateUrl });
  }

  async startSession(
    _storage: FlamecastStorage,
    opts: {
      agentName: string;
      spawn: { command: string; args: string[] };
      cwd: string;
      runtime: { provider: string } & Record<string, unknown>;
      runtimeInstance?: string;
      startedAt: string;
      callbackUrl?: string;
      webhooks?: WebhookConfig[];
    },
  ): Promise<{ sessionId: string }> {
    const sessionId = crypto.randomUUID();
    const providerName = opts.runtime.provider ?? "local";
    const runtime = this.runtimes[providerName];
    if (!runtime) {
      throw new Error(
        `Unknown runtime: "${providerName}". Available: ${Object.keys(this.runtimes).join(", ")}`,
      );
    }

    // Resolve runtime instance and get its base URL
    const instanceName = runtime.onlyOne
      ? providerName
      : (opts.runtimeInstance ?? providerName);

    await runtime.start?.(instanceName);
    // Derive HTTP URL from the runtime's websocket URL. Not all runtimes may
    // expose getWebsocketUrl — a dedicated getBaseUrl() on the Runtime interface
    // would be cleaner (see SDD §5.6). For now this works for Node/Docker runtimes.
    const runtimeUrl = runtime.getWebsocketUrl?.(instanceName);
    if (!runtimeUrl) {
      throw new Error(`Runtime "${providerName}" did not provide a base URL`);
    }
    const runtimeHttpUrl = runtimeUrl
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:");

    // Callback URL points to the VO's handleCallback handler so all session
    // events (permission_request, end_turn, session_end) flow through Restate,
    // activating durable permissions, webhook delivery, and pubsub streaming.
    const callbackUrl = `${this.restateUrl}/FlamecastSession/${sessionId}/handleCallback`;

    // Delegate to the FlamecastSession Virtual Object
    const result = await this.restateClient
      .objectClient(FlamecastSession, sessionId)
      .start({
        runtimeUrl: runtimeHttpUrl,
        spawn: opts.spawn,
        cwd: opts.cwd,
        setup: opts.runtime.setup as string | undefined,
        env: opts.runtime.env as Record<string, string> | undefined,
        callbackUrl,
        agentName: opts.agentName,
        runtimeName: providerName,
        webhooks: opts.webhooks,
      });

    // Cache hostUrl for fast proxy calls
    this.hostUrlCache.set(sessionId, result.hostUrl);
    return { sessionId };
  }

  async recoverSession(
    _sessionId: string,
    _runtimeInfo: SessionRuntimeInfo,
    _webhooks?: WebhookConfig[],
  ): Promise<boolean> {
    // No-op — Restate replays from journal automatically.
    return true;
  }

  async terminateSession(
    _storage: FlamecastStorage,
    sessionId: string,
  ): Promise<void> {
    await this.restateClient
      .objectClient(FlamecastSession, sessionId)
      .terminate();
    this.hostUrlCache.delete(sessionId);
  }

  async hasSession(sessionId: string): Promise<boolean> {
    const meta = await this.restateClient
      .objectClient(FlamecastSession, sessionId)
      .getStatus();
    return meta?.status === "active";
  }

  async listSessionIds(): Promise<string[]> {
    // Restate doesn't provide a native "list all VO keys" API.
    // Uses local cache — repopulated on proxy calls.
    return Array.from(this.hostUrlCache.keys());
  }

  async getWebsocketUrl(sessionId: string): Promise<string | undefined> {
    const meta = await this.restateClient
      .objectClient(FlamecastSession, sessionId)
      .getStatus();
    return meta?.websocketUrl;
  }

  async getRuntimeName(sessionId: string): Promise<string | undefined> {
    const meta = await this.restateClient
      .objectClient(FlamecastSession, sessionId)
      .getStatus();
    return meta?.runtimeName;
  }

  async getWebhooks(sessionId: string): Promise<WebhookConfig[]> {
    return await this.restateClient
      .objectClient(FlamecastSession, sessionId)
      .getWebhooks();
  }

  async proxyRequest(
    sessionId: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    // Route prompts through the VO's turn handler for journaling and
    // automatic serialization via VO exclusivity.
    if (path === "/prompt" && init.method === "POST" && init.body) {
      const body = JSON.parse(
        typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as ArrayBuffer),
      ) as { text: string };
      const result = await this.restateClient
        .objectClient(FlamecastSession, sessionId)
        .turn({ text: body.text });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Everything else proxies directly to the session-host
    let hostUrl = this.hostUrlCache.get(sessionId);
    if (!hostUrl) {
      const meta = await this.restateClient
        .objectClient(FlamecastSession, sessionId)
        .getStatus();
      if (!meta) throw new Error(`Session ${sessionId} not found`);
      hostUrl = meta.hostUrl;
      this.hostUrlCache.set(sessionId, hostUrl);
    }
    return await fetch(`${hostUrl}/sessions/${sessionId}${path}`, init);
  }

  async proxyWebSocket(
    sessionId: string,
    request: Request,
  ): Promise<Response> {
    let hostUrl = this.hostUrlCache.get(sessionId);
    if (!hostUrl) {
      const meta = await this.restateClient
        .objectClient(FlamecastSession, sessionId)
        .getStatus();
      if (!meta) throw new Error(`Session ${sessionId} not found`);
      hostUrl = meta.hostUrl;
      this.hostUrlCache.set(sessionId, hostUrl);
    }
    return await fetch(`${hostUrl}/sessions/${sessionId}/ws`, {
      headers: request.headers,
    });
  }
}
