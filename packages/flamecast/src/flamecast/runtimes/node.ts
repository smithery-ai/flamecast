import type { Runtime } from "../runtime.js";

/**
 * NodeRuntime — connects to a SessionHost over HTTP.
 *
 * With no arguments, discovers the SessionHost URL from the RUNTIME_URL
 * environment variable, or defaults to http://localhost:8787.
 * Pass a URL explicitly for deployed environments.
 */
export class NodeRuntime implements Runtime {
  private readonly url: string;

  constructor(url?: string) {
    this.url = url ?? process.env.RUNTIME_URL ?? "http://localhost:8787";
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const originalUrl = new URL(request.url);
    const targetUrl = new URL(this.url);
    targetUrl.pathname = `/sessions/${sessionId}${originalUrl.pathname}`;

    const init: RequestInit & { duplex?: string } = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      duplex: request.body ? "half" : undefined,
    };
    return fetch(targetUrl.toString(), init);
  }
}
