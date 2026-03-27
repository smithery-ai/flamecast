import type { Runtime } from "@flamecast/protocol/runtime";

/**
 * NodeRuntime — connects to a RuntimeHost over HTTP.
 *
 * With no arguments, discovers the RuntimeHost URL from the RUNTIME_URL
 * environment variable, or defaults to http://localhost:8787.
 * Pass a URL explicitly for deployed environments.
 */
export class NodeRuntime implements Runtime {
  readonly onlyOne = true;
  private readonly url: string;

  constructor(url?: string) {
    this.url = url ?? process.env.RUNTIME_URL ?? "http://localhost:8787";
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const originalUrl = new URL(request.url);
    const targetUrl = new URL(this.url);
    targetUrl.pathname = `/sessions/${sessionId}${originalUrl.pathname}`;
    targetUrl.search = originalUrl.search;

    const init: RequestInit & { duplex?: string } = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      duplex: request.body ? "half" : undefined,
    };
    const resp = await fetch(targetUrl.toString(), init);

    // For /start responses, inject the runtime-host URLs (shared across all sessions)
    if (originalUrl.pathname.endsWith("/start") && request.method === "POST" && resp.ok) {
      const body = await resp.json();
      const runtimeUrl = new URL(this.url);
      body.hostUrl = runtimeUrl.toString().replace(/\/$/, "");
      body.websocketUrl = runtimeUrl.toString().replace(/^http/, "ws").replace(/\/$/, "");
      return new Response(JSON.stringify(body), {
        status: resp.status,
        headers: resp.headers,
      });
    }

    return resp;
  }

  async fetchInstance(_instanceId: string, request: Request): Promise<Response> {
    const originalUrl = new URL(request.url);
    const targetUrl = new URL(this.url);
    targetUrl.pathname = originalUrl.pathname;
    targetUrl.search = originalUrl.search;

    const init: RequestInit & { duplex?: string } = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      duplex: request.body ? "half" : undefined,
    };
    return fetch(targetUrl.toString(), init);
  }
}
