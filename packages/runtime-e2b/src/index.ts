import { Sandbox } from "@e2b/code-interpreter";
import type { Runtime } from "@flamecast/protocol/runtime";

/**
 * E2BRuntime — provisions SessionHosts in E2B sandboxes.
 *
 * Each session gets its own sandbox. The SessionHost runs inside the sandbox
 * and is reachable via E2B's port forwarding (https://{PORT}-{SANDBOX_ID}.e2b.app).
 */
export class E2BRuntime implements Runtime {
  private readonly apiKey: string;
  private readonly template: string;
  private readonly sandboxes = new Map<string, { sandboxId: string; hostUrl: string }>();

  constructor(opts: { apiKey: string; template?: string }) {
    this.apiKey = opts.apiKey;
    this.template = opts.template ?? "flamecast-session-host";
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith("/start") && request.method === "POST") {
      if (this.sandboxes.has(sessionId)) {
        return new Response(JSON.stringify({ error: "Session already exists" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        const sandbox = await Sandbox.create(this.template, {
          apiKey: this.apiKey,
          timeoutMs: 60 * 60 * 1000,
        });

        const port = 8080;
        await sandbox.commands.run(`SESSION_HOST_PORT=${port} node /app/dist/index.js`, {
          background: true,
        });

        await this.waitForReady(sandbox, port);

        const host = sandbox.getHost(port);
        const hostUrl = `https://${host}`;

        this.sandboxes.set(sessionId, { sandboxId: sandbox.sandboxId, hostUrl });

        const body = await request.text();
        const resp = await fetch(`${hostUrl}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        const result = await resp.json();
        result.hostUrl = hostUrl;
        result.websocketUrl = `wss://${host}`;

        return new Response(JSON.stringify(result), {
          status: resp.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: err instanceof Error ? err.message : "Failed to create sandbox",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const entry = this.sandboxes.get(sessionId);
    if (!entry) {
      return new Response(JSON.stringify({ error: `Session ${sessionId} not found` }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = request.method !== "GET" ? await request.text() : undefined;
    const resp = await fetch(`${entry.hostUrl}${path}`, {
      method: request.method,
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (path.endsWith("/terminate") && request.method === "POST") {
      try {
        const sandbox = await Sandbox.connect(entry.sandboxId, { apiKey: this.apiKey });
        await sandbox.kill();
      } catch {
        // Best-effort cleanup
      }
      this.sandboxes.delete(sessionId);
    }

    return new Response(await resp.text(), {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  getRuntimeMeta(sessionId: string): Record<string, unknown> | null {
    const entry = this.sandboxes.get(sessionId);
    if (!entry) return null;
    return { sandboxId: entry.sandboxId, hostUrl: entry.hostUrl };
  }

  async reconnect(
    sessionId: string,
    runtimeMeta: Record<string, unknown> | null,
  ): Promise<boolean> {
    if (!runtimeMeta) return false;
    const sandboxId = typeof runtimeMeta.sandboxId === "string" ? runtimeMeta.sandboxId : undefined;
    const hostUrl = typeof runtimeMeta.hostUrl === "string" ? runtimeMeta.hostUrl : undefined;
    if (!sandboxId || !hostUrl) return false;

    try {
      const sandbox = await Sandbox.connect(sandboxId, { apiKey: this.apiKey });
      // Check if the sandbox is still running by probing health
      const host = sandbox.getHost(8080);
      const resp = await fetch(`https://${host}/health`).catch(() => null);
      if (!resp?.ok) return false;

      this.sandboxes.set(sessionId, { sandboxId, hostUrl });
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    for (const [, entry] of this.sandboxes) {
      try {
        const sandbox = await Sandbox.connect(entry.sandboxId, { apiKey: this.apiKey });
        await sandbox.kill();
      } catch {
        // Best-effort
      }
    }
    this.sandboxes.clear();
  }

  private async waitForReady(
    sandbox: { getHost(port: number): string },
    port: number,
    timeoutMs = 30_000,
  ): Promise<void> {
    const host = sandbox.getHost(port);
    const healthUrl = `https://${host}/health`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const resp = await fetch(healthUrl);
        if (resp.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`SessionHost not ready after ${timeoutMs}ms`);
  }
}
