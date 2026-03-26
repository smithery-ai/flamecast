import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "@e2b/code-interpreter";
import type { Runtime } from "@flamecast/protocol/runtime";

// ---------------------------------------------------------------------------
// Session-host binary resolution (same as DockerRuntime)
// ---------------------------------------------------------------------------

function resolveSessionHostBinary(): string {
  if (process.env.SESSION_HOST_BINARY) {
    const p = process.env.SESSION_HOST_BINARY;
    if (!existsSync(p)) {
      throw new Error(`SESSION_HOST_BINARY points to "${p}" which does not exist`);
    }
    return p;
  }

  try {
    const pkgJsonUrl = import.meta.resolve("@flamecast/session-host-go/package.json");
    const pkgDir = dirname(fileURLToPath(pkgJsonUrl));
    const binaryPath = join(pkgDir, "dist", "session-host");
    if (existsSync(binaryPath)) return binaryPath;
  } catch {
    // Package not resolvable
  }

  throw new Error(
    "No session-host binary found. Install Go and run: " +
      "pnpm --filter @flamecast/session-host-go run postinstall",
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" };
const SANDBOX_BIN_PATH = "/usr/local/bin/session-host";
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_BASE_PORT = 9000;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PortSlot {
  port: number;
  inUse: boolean;
}

interface InstanceEntry {
  sandboxId: string;
  ports: PortSlot[];
}

interface SessionEntry {
  instanceName: string;
  port: number;
  hostUrl: string;
  websocketUrl: string;
}

// ---------------------------------------------------------------------------
// E2BRuntime
// ---------------------------------------------------------------------------

/**
 * E2BRuntime — one E2B sandbox per runtime instance.
 *
 * When `start(instanceId)` is called, an E2B sandbox is created from the
 * configured base template, and the session-host Go binary is uploaded into it.
 * Sessions are started inside the sandbox by running the binary on a unique port.
 *
 * `pause(instanceId)` pauses the sandbox (freezing all session-hosts).
 * `stop(instanceId)` kills the sandbox entirely.
 */
export class E2BRuntime implements Runtime {
  private readonly apiKey: string;
  private readonly template: string;
  private readonly maxSessions: number;
  private readonly basePort: number;

  /** instanceName → E2B sandbox + port pool */
  private readonly instances = new Map<string, InstanceEntry>();
  /** sessionId → which instance + assigned port/URLs */
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(opts: {
    apiKey: string;
    template?: string;
    maxSessionsPerInstance?: number;
    basePort?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.template = opts.template ?? "base";
    this.maxSessions = opts.maxSessionsPerInstance ?? DEFAULT_MAX_SESSIONS;
    this.basePort = opts.basePort ?? DEFAULT_BASE_PORT;
  }

  // ---------------------------------------------------------------------------
  // Instance lifecycle
  // ---------------------------------------------------------------------------

  async start(instanceId: string): Promise<void> {
    const existing = this.instances.get(instanceId);
    if (existing) {
      // Resume a paused sandbox — Sandbox.connect auto-resumes
      await Sandbox.connect(existing.sandboxId, { apiKey: this.apiKey });
      return;
    }

    // Create a new sandbox
    const sandbox = await Sandbox.create(this.template, {
      apiKey: this.apiKey,
      timeoutMs: 60 * 60 * 1000,
      metadata: { "flamecast.instance": instanceId },
    });

    // Upload the session-host binary into the sandbox
    const binaryPath = resolveSessionHostBinary();
    const binaryBlob = new Blob([readFileSync(binaryPath)]);
    await sandbox.files.write(SANDBOX_BIN_PATH, binaryBlob);
    await sandbox.commands.run(`chmod +x ${SANDBOX_BIN_PATH}`);

    const ports: PortSlot[] = [];
    for (let i = 0; i < this.maxSessions; i++) {
      ports.push({ port: this.basePort + i, inUse: false });
    }

    this.instances.set(instanceId, { sandboxId: sandbox.sandboxId, ports });
    console.log(
      `[E2BRuntime] Instance "${instanceId}" started (sandbox=${sandbox.sandboxId})`,
    );
  }

  async stop(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;

    for (const [sid, session] of this.sessions) {
      if (session.instanceName === instanceId) {
        this.sessions.delete(sid);
      }
    }

    try {
      await Sandbox.kill(inst.sandboxId, { apiKey: this.apiKey });
    } catch {
      // Sandbox may already be gone
    }

    this.instances.delete(instanceId);
    console.log(`[E2BRuntime] Instance "${instanceId}" stopped`);
  }

  async pause(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance "${instanceId}" not found`);

    await Sandbox.pause(inst.sandboxId, { apiKey: this.apiKey });
    console.log(`[E2BRuntime] Instance "${instanceId}" paused`);
  }

  async getInstanceStatus(
    instanceId: string,
  ): Promise<"running" | "stopped" | "paused" | undefined> {
    const inst = this.instances.get(instanceId);
    if (!inst) return undefined;

    try {
      const info = await Sandbox.getFullInfo(inst.sandboxId, { apiKey: this.apiKey });
      if (info.state === "paused") return "paused";
      if (info.state === "running") return "running";
      return "stopped";
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Session handling
  // ---------------------------------------------------------------------------

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

  getRuntimeMeta(sessionId: string): Record<string, unknown> | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const inst = this.instances.get(session.instanceName);
    return {
      instanceName: session.instanceName,
      sandboxId: inst?.sandboxId,
      port: session.port,
      hostUrl: session.hostUrl,
      websocketUrl: session.websocketUrl,
    };
  }

  async reconnect(
    sessionId: string,
    runtimeMeta: Record<string, unknown> | null,
  ): Promise<boolean> {
    if (!runtimeMeta) return false;
    const instanceName = typeof runtimeMeta.instanceName === "string" ? runtimeMeta.instanceName : undefined;
    const sandboxId = typeof runtimeMeta.sandboxId === "string" ? runtimeMeta.sandboxId : undefined;
    const port = typeof runtimeMeta.port === "number" ? runtimeMeta.port : undefined;
    const hostUrl = typeof runtimeMeta.hostUrl === "string" ? runtimeMeta.hostUrl : undefined;
    const websocketUrl = typeof runtimeMeta.websocketUrl === "string" ? runtimeMeta.websocketUrl : undefined;
    if (!instanceName || !sandboxId || !port || !hostUrl || !websocketUrl) return false;

    try {
      if (!this.instances.has(instanceName)) {
        const info = await Sandbox.getFullInfo(sandboxId, { apiKey: this.apiKey });
        if (info.state !== "running") return false;

        const ports: PortSlot[] = [];
        for (let i = 0; i < this.maxSessions; i++) {
          ports.push({ port: this.basePort + i, inUse: false });
        }
        this.instances.set(instanceName, { sandboxId, ports });
      }

      const resp = await fetch(`${hostUrl}/health`).catch(() => null);
      if (!resp?.ok) return false;

      const inst = this.instances.get(instanceName);
      if (!inst) return false;
      const slot = inst.ports.find((p) => p.port === port);
      if (slot) slot.inUse = true;

      this.sessions.set(sessionId, { instanceName, port, hostUrl, websocketUrl });
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    const instanceNames = [...this.instances.keys()];
    await Promise.allSettled(instanceNames.map((name) => this.stop(name)));
    this.instances.clear();
    this.sessions.clear();
  }

  // ---------------------------------------------------------------------------
  // Request handlers
  // ---------------------------------------------------------------------------

  private async handleStart(sessionId: string, request: Request): Promise<Response> {
    if (this.sessions.has(sessionId)) {
      return jsonResponse({ error: `Session "${sessionId}" already exists` }, 409);
    }

    try {
      const parsed: Record<string, unknown> = JSON.parse(await request.text());
      const instanceName = typeof parsed.instanceName === "string" ? parsed.instanceName : undefined;

      if (!instanceName) {
        return jsonResponse(
          { error: "Missing instanceName — create a runtime instance first" },
          400,
        );
      }

      const inst = this.instances.get(instanceName);
      if (!inst) {
        return jsonResponse({ error: `Runtime instance "${instanceName}" not found` }, 404);
      }

      const slot = inst.ports.find((p) => !p.inUse);
      if (!slot) {
        return jsonResponse(
          { error: `No available ports in instance "${instanceName}" (max ${this.maxSessions} sessions)` },
          503,
        );
      }

      // Connect to sandbox and start session-host binary on the assigned port
      const sandbox = await Sandbox.connect(inst.sandboxId, { apiKey: this.apiKey });

      // Verify the binary exists and is executable
      const checkResult = await sandbox.commands.run(`ls -la ${SANDBOX_BIN_PATH} && file ${SANDBOX_BIN_PATH}`);
      console.log(`[E2BRuntime] Binary check: ${checkResult.stdout.trim()}`);
      if (checkResult.exitCode !== 0) {
        throw new Error(`Session-host binary not found in sandbox: ${checkResult.stderr}`);
      }

      // Start session-host in background, capturing output to a log file for diagnostics
      const logFile = `/tmp/session-host-${slot.port}.log`;
      console.log(`[E2BRuntime] Starting session-host on port ${slot.port}...`);
      await sandbox.commands.run(
        `SESSION_HOST_PORT=${slot.port} RUNTIME_SETUP_ENABLED=1 nohup ${SANDBOX_BIN_PATH} > ${logFile} 2>&1 &`,
        { timeoutMs: 5_000 },
      );

      // Give it a moment to start (or crash), then check
      await new Promise((r) => setTimeout(r, 2_000));
      const checkProc = await sandbox.commands.run(
        `ps aux | grep session-host | grep -v grep; echo "---LOG---"; cat ${logFile}`,
        { timeoutMs: 5_000 },
      );
      console.log(`[E2BRuntime] Process + log check:\n${checkProc.stdout.trim()}`);

      // If the process isn't running, it crashed — surface the log
      if (!checkProc.stdout.includes(SANDBOX_BIN_PATH)) {
        const logContent = checkProc.stdout.split("---LOG---")[1]?.trim() ?? "(no output)";
        throw new Error(`Session-host crashed on startup. Log:\n${logContent}`);
      }

      const host = sandbox.getHost(slot.port);
      const hostUrl = `https://${host}`;
      const websocketUrl = `wss://${host}`;

      console.log(`[E2BRuntime] Host URL: ${hostUrl}`);

      slot.inUse = true;
      this.sessions.set(sessionId, { instanceName, port: slot.port, hostUrl, websocketUrl });

      await this.waitForReady(hostUrl);

      // Forward to session-host
      parsed.workspace = "/home/user";
      delete parsed.instanceName;

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
      result.websocketUrl = websocketUrl;

      return new Response(JSON.stringify(result), {
        status: resp.status,
        headers: JSON_HEADERS,
      });
    } catch (err) {
      const session = this.sessions.get(sessionId);
      if (session) {
        const inst = this.instances.get(session.instanceName);
        const slot = inst?.ports.find((p) => p.port === session.port);
        if (slot) slot.inUse = false;
        this.sessions.delete(sessionId);
      }
      return jsonResponse(
        { error: err instanceof Error ? err.message : "Failed to start session" },
        500,
      );
    }
  }

  private async handleTerminate(sessionId: string, path: string): Promise<Response> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    const resp = await fetch(`${session.hostUrl}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
    });

    const inst = this.instances.get(session.instanceName);
    const slot = inst?.ports.find((p) => p.port === session.port);
    if (slot) slot.inUse = false;
    this.sessions.delete(sessionId);

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
    const session = this.sessions.get(sessionId);
    if (!session) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    const body = request.method !== "GET" ? await request.text() : undefined;
    const resp = await fetch(`${session.hostUrl}${path}`, {
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
  // Readiness check
  // ---------------------------------------------------------------------------

  private async waitForReady(hostUrl: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;

    while (Date.now() < deadline) {
      attempts++;
      try {
        const resp = await fetch(`${hostUrl}/health`);
        if (resp.ok) {
          console.log(`[E2BRuntime] Session-host ready after ${attempts} attempts`);
          return;
        }
        console.log(`[E2BRuntime] Health check attempt ${attempts}: status ${resp.status}`);
      } catch (err) {
        if (attempts % 5 === 0) {
          console.log(`[E2BRuntime] Health check attempt ${attempts}: ${err instanceof Error ? err.message : "connection failed"}`);
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`SessionHost at ${hostUrl} not ready after ${timeoutMs}ms (${attempts} attempts)`);
  }
}
