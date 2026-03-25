import type { Runtime } from "../runtime.js";

/** Shape of an E2B sandbox instance (subset used by this module). */
interface E2BSandboxInstance {
  sandboxId: string;
  commands: { run(cmd: string, opts?: { background?: boolean }): Promise<unknown> };
  getHost(port: number): string;
  kill(): Promise<void>;
}

/** Shape of the E2B Sandbox class (static methods used by this module). */
interface E2BSandboxClass {
  create(opts: {
    template: string;
    apiKey: string;
    timeoutMs: number;
  }): Promise<E2BSandboxInstance>;
  connect(sandboxId: string, opts: { apiKey: string }): Promise<E2BSandboxInstance>;
}

/**
 * E2BRuntime — provisions SessionHosts in E2B sandboxes.
 *
 * Each session gets its own sandbox. The SessionHost runs inside the sandbox
 * and is reachable via E2B's port forwarding (https://{PORT}-{SANDBOX_ID}.e2b.app).
 *
 * Requires:
 * - An E2B template with the SessionHost image pre-installed
 * - E2B API key
 */
export class E2BRuntime implements Runtime {
  private readonly apiKey: string;
  private readonly template: string;
  private readonly sandboxes = new Map<string, { sandboxId: string; hostUrl: string }>();

  // Lazily imported E2B SDK (avoid top-level import for tree-shaking)
  private SandboxClass: E2BSandboxClass | null = null;

  constructor(opts: { apiKey: string; template?: string }) {
    this.apiKey = opts.apiKey;
    this.template = opts.template ?? "flamecast-session-host";
  }

  private async getSandboxClass(): Promise<E2BSandboxClass> {
    if (!this.SandboxClass) {
      const mod = await import("@e2b/code-interpreter");
      // oxlint-disable-next-line no-type-assertion/no-type-assertion
      this.SandboxClass = mod.Sandbox as E2BSandboxClass;
    }
    return this.SandboxClass;
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Provision sandbox on /start
    if (path.endsWith("/start") && request.method === "POST") {
      if (this.sandboxes.has(sessionId)) {
        return new Response(JSON.stringify({ error: "Session already exists" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        const Sandbox = await this.getSandboxClass();
        const sandbox = await Sandbox.create({
          template: this.template,
          apiKey: this.apiKey,
          timeoutMs: 60 * 60 * 1000, // 1 hour
        });

        // Start the session host inside the sandbox
        const port = 8080;
        await sandbox.commands.run(`SESSION_HOST_PORT=${port} node /app/dist/index.js`, {
          background: true,
        });

        // Wait for session host to be ready
        await this.waitForReady(sandbox, port);

        const host = sandbox.getHost(port);
        const hostUrl = `https://${host}`;

        this.sandboxes.set(sessionId, { sandboxId: sandbox.sandboxId, hostUrl });

        // Forward the /start request to the session host
        const body = await request.text();
        const resp = await fetch(`${hostUrl}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        const result = await resp.json();
        // Override hostUrl/websocketUrl with the E2B-reachable URLs
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

    // Forward to existing sandbox
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

    // Clean up sandbox on terminate
    if (path.endsWith("/terminate") && request.method === "POST") {
      try {
        const Sandbox = await this.getSandboxClass();
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

  async dispose(): Promise<void> {
    const Sandbox = await this.getSandboxClass().catch(() => null);
    if (!Sandbox) return;

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
    const url = `https://${host}/health`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const resp = await fetch(url);
        if (resp.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`SessionHost not ready after ${timeoutMs}ms`);
  }
}
