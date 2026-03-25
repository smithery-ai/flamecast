import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Sandbox,
  Template,
  defaultBuildLogger,
  waitForPort,
} from "@e2b/code-interpreter";
import type { Runtime } from "@flamecast/sdk/runtime";

const SESSION_HOST_PORT = 8080;
const SESSION_HOST_REPO = "https://github.com/smithery-ai/flamecast.git";
const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Generate a Dockerfile that mirrors DockerRuntime's pattern:
 * base image → system deps → session-host (cloned from repo) → optional setup.
 */
function generateDockerfile(baseImage: string, setup?: string): string {
  const lines = [
    `FROM ${baseImage}`,
    `RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates git && rm -rf /var/lib/apt/lists/*`,
    // Clone repo and build session-host
    `RUN git clone --depth 1 ${SESSION_HOST_REPO} /tmp/flamecast \\`,
    `    && cp -r /tmp/flamecast/packages/session-host /session-host \\`,
    `    && cd /session-host && npm install --omit=dev \\`,
    `    && rm -rf /tmp/flamecast`,
    // Agent workspace
    `WORKDIR /workspace`,
  ];

  if (setup) {
    lines.push(`COPY setup.sh /tmp/setup.sh`);
    lines.push(`RUN sh /tmp/setup.sh && rm /tmp/setup.sh`);
  }

  lines.push(`ENV SESSION_HOST_PORT=${SESSION_HOST_PORT}`);
  lines.push(`EXPOSE ${SESSION_HOST_PORT}`);

  return lines.join("\n") + "\n";
}

/**
 * E2BRuntime — provisions SessionHosts in E2B sandboxes.
 *
 * Mirrors DockerRuntime's approach: constructs a Dockerfile from `baseImage` +
 * session-host + optional `setup` script, builds it as an E2B template, then
 * creates sandboxes from that template.
 */
export class E2BRuntime implements Runtime {
  private readonly apiKey: string;
  private readonly baseImage: string;
  private readonly sandboxes = new Map<string, { sandboxId: string; hostUrl: string }>();
  /** Cache of E2B template names keyed by content hash. */
  private readonly builtTemplates = new Map<string, string>();

  constructor(opts: {
    apiKey: string;
    /** Base Docker image (default: "node:22-slim"). */
    baseImage?: string;
  }) {
    this.apiKey = opts.apiKey;
    this.baseImage = opts.baseImage ?? "node:22-slim";
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith("/start") && request.method === "POST") {
      return this.handleStart(sessionId, request);
    }

    if (path.endsWith("/terminate") && request.method === "POST") {
      return this.handleTerminate(sessionId, path);
    }

    return this.proxyRequest(sessionId, path, request);
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

  // ---------------------------------------------------------------------------
  // Request handlers
  // ---------------------------------------------------------------------------

  private async handleStart(sessionId: string, request: Request): Promise<Response> {
    if (this.sandboxes.has(sessionId)) {
      return jsonResponse({ error: `Session "${sessionId}" already exists` }, 409);
    }

    try {
      const parsed = JSON.parse(await request.text()) as Record<string, unknown>;
      const setup = parsed.setup as string | undefined;

      // Build (or reuse) an E2B template from the Dockerfile
      const templateName = await this.resolveTemplate(setup);

      const sandbox = await Sandbox.create(templateName, {
        apiKey: this.apiKey,
        timeoutMs: 60 * 60 * 1000,
      });

      try {
        // Session-host is already running — E2B's waitForPort ensures it's ready
        const host = sandbox.getHost(SESSION_HOST_PORT);
        const hostUrl = `https://${host}`;

        this.sandboxes.set(sessionId, { sandboxId: sandbox.sandboxId, hostUrl });

        // Override workspace to sandbox workspace
        parsed.workspace = "/workspace";

        const resp = await fetch(`${hostUrl}/start`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(parsed),
        });

        const text = await resp.text();
        let result: Record<string, unknown>;
        try {
          result = JSON.parse(text);
        } catch {
          throw new Error(`SessionHost /start failed (${resp.status}): ${text}`);
        }

        if (!resp.ok) {
          throw new Error(`SessionHost /start failed (${resp.status}): ${result.error ?? text}`);
        }

        result.hostUrl = hostUrl;
        result.websocketUrl = `wss://${host}`;

        return new Response(JSON.stringify(result), {
          status: resp.status,
          headers: JSON_HEADERS,
        });
      } catch (err) {
        this.sandboxes.delete(sessionId);
        await sandbox.kill().catch(() => {});
        throw err;
      }
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : "Failed to create sandbox" },
        500,
      );
    }
  }

  private async handleTerminate(sessionId: string, path: string): Promise<Response> {
    const entry = this.sandboxes.get(sessionId);
    if (!entry) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    const resp = await fetch(`${entry.hostUrl}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
    });

    try {
      const sandbox = await Sandbox.connect(entry.sandboxId, { apiKey: this.apiKey });
      await sandbox.kill();
    } catch {
      // Best-effort cleanup
    }
    this.sandboxes.delete(sessionId);

    return new Response(await resp.text(), {
      status: resp.status,
      headers: JSON_HEADERS,
    });
  }

  private async proxyRequest(
    sessionId: string,
    path: string,
    request: Request,
  ): Promise<Response> {
    const entry = this.sandboxes.get(sessionId);
    if (!entry) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    const body = request.method !== "GET" ? await request.text() : undefined;
    const resp = await fetch(`${entry.hostUrl}${path}`, {
      method: request.method,
      headers: JSON_HEADERS,
      body,
    });

    return new Response(await resp.text(), {
      status: resp.status,
      headers: JSON_HEADERS,
    });
  }

  // ---------------------------------------------------------------------------
  // Template resolution (mirrors DockerRuntime's image resolution)
  // ---------------------------------------------------------------------------

  /**
   * Build (or reuse) an E2B template from a generated Dockerfile.
   * Uses the same Dockerfile pattern as DockerRuntime.
   */
  private async resolveTemplate(setup?: string): Promise<string> {
    const dockerfileContent = generateDockerfile(this.baseImage, setup);
    const hashInput = dockerfileContent + (setup ?? "");
    const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 12);
    const templateName = `flamecast-session-${hash}`;

    // Return cached template if it exists
    const cached = this.builtTemplates.get(hash);
    if (cached) {
      const exists = await Template.exists(cached, { apiKey: this.apiKey });
      if (exists) return cached;
      this.builtTemplates.delete(hash);
    }

    // Check if template already exists on E2B from a previous runtime instance
    const alreadyExists = await Template.exists(templateName, { apiKey: this.apiKey });
    if (alreadyExists) {
      this.builtTemplates.set(hash, templateName);
      return templateName;
    }

    console.log(`[E2BRuntime] Building template ${templateName}`);

    // If there's a setup script, we need a build context for COPY setup.sh
    let tmpDir: string | undefined;
    let template;

    if (setup) {
      tmpDir = mkdtempSync(join(tmpdir(), "flamecast-e2b-"));
      writeFileSync(join(tmpDir, "Dockerfile"), dockerfileContent);
      writeFileSync(join(tmpDir, "setup.sh"), setup);
      template = Template()
        .fromDockerfile(join(tmpDir, "Dockerfile"))
        .setStartCmd(`node /session-host/dist/index.js`, waitForPort(SESSION_HOST_PORT));
    } else {
      // No build context needed — Dockerfile only uses RUN (git clone)
      template = Template()
        .fromDockerfile(dockerfileContent)
        .setStartCmd(`node /session-host/dist/index.js`, waitForPort(SESSION_HOST_PORT));
    }

    try {
      await Template.build(template, templateName, {
        apiKey: this.apiKey,
        onBuildLogs: defaultBuildLogger(),
      });
    } finally {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }

    this.builtTemplates.set(hash, templateName);
    return templateName;
  }

}
