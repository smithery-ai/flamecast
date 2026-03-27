import { readFileSync, existsSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "@e2b/code-interpreter";
import type { Runtime } from "@flamecast/protocol/runtime";
import { getRequestPath } from "./request-path.js";

// ---------------------------------------------------------------------------
// Session-host binary resolution (same as DockerRuntime)
// ---------------------------------------------------------------------------

/** Try to find the session-host binary on the local filesystem. Returns `null` if unavailable. */
function resolveSessionHostBinary(): string | null {
  if (process.env.SESSION_HOST_BINARY) {
    const p = process.env.SESSION_HOST_BINARY;
    if (!existsSync(p)) {
      throw new Error(`SESSION_HOST_BINARY points to "${p}" which does not exist`);
    }
    return p;
  }

  // E2B sandboxes are always x86_64 — resolve the amd64 binary specifically
  try {
    const pkgJsonUrl = import.meta.resolve("@flamecast/session-host-go/package.json");
    const pkgDir = dirname(fileURLToPath(pkgJsonUrl));
    const amd64Path = join(pkgDir, "dist", "session-host-amd64");
    if (existsSync(amd64Path)) return amd64Path;
  } catch {
    // Package not resolvable (e.g. bundled Workers environment)
  }

  return null;
}

/**
 * Stable download URL for the session-host binary. Uses a pinned
 * `session-host-latest` release tag that CI overwrites on each build,
 * so this URL never changes.
 */
const SESSION_HOST_DEFAULT_URL =
  "https://github.com/smithery-ai/flamecast/releases/download/session-host-latest/session-host-amd64";

/**
 * Resolve the download URL for the session-host-amd64 binary.
 *
 * Resolution order:
 *  1. `SESSION_HOST_URL` env var (explicit override, works for any runtime)
 *  2. Constructor `sessionHostUrl` option (per-instance override)
 *  3. Stable default URL (GitHub release tag `session-host-latest`)
 */
function resolveSessionHostReleaseUrl(): string {
  const envUrl = typeof process !== "undefined" ? process.env?.SESSION_HOST_URL : undefined;
  return envUrl ?? SESSION_HOST_DEFAULT_URL;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" };
const SANDBOX_BIN_PATH = "/usr/local/bin/session-host";
const SANDBOX_WORKSPACE = "/home/user";
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_BASE_PORT = 9000;
const FLAMECAST_INSTANCE_LABEL = "flamecast.instance";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

type RuntimeEntry = {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
};

type GitIgnoreRule = {
  negated: boolean;
  regex: RegExp;
};

function globToRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if ("\\^$+?.()|{}[]".includes(char)) {
      source += `\\${char}`;
      continue;
    }
    source += char;
  }
  return source;
}

function parseGitIgnoreRule(line: string): GitIgnoreRule | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const literal = trimmed.startsWith("\\#") || trimmed.startsWith("\\!");
  const negated = !literal && trimmed.startsWith("!");
  const rawPattern = negated ? trimmed.slice(1) : literal ? trimmed.slice(1) : trimmed;
  if (!rawPattern) return null;

  const directoryOnly = rawPattern.endsWith("/");
  const anchored = rawPattern.startsWith("/");
  const normalized = rawPattern.slice(anchored ? 1 : 0, directoryOnly ? -1 : undefined);
  if (!normalized) return null;

  const hasSlash = normalized.includes("/");
  const source = globToRegexSource(normalized);
  const regex = !hasSlash
    ? new RegExp(directoryOnly ? `(^|/)${source}(/|$)` : `(^|/)${source}$`, "u")
    : anchored
      ? new RegExp(directoryOnly ? `^${source}(/|$)` : `^${source}$`, "u")
      : new RegExp(directoryOnly ? `(^|.*/)${source}(/|$)` : `(^|.*/)${source}$`, "u");

  return { negated, regex };
}

function parseGitIgnoreRules(content: string): GitIgnoreRule[] {
  const rules = [parseGitIgnoreRule(".git/")].filter(
    (rule): rule is GitIgnoreRule => rule !== null,
  );
  const extra = process.env.FILE_WATCHER_IGNORE;
  if (extra) {
    for (const pattern of extra.split(",")) {
      const rule = parseGitIgnoreRule(pattern.trim());
      if (rule) rules.push(rule);
    }
  }

  for (const line of content.split(/\r?\n/u)) {
    const rule = parseGitIgnoreRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

function isGitIgnored(path: string, rules: GitIgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(path)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function resolveWorkspacePath(filePath: string): string | null {
  if (!filePath || filePath.includes("\0")) return null;
  const normalized = posix.normalize(filePath);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return null;
  }
  return posix.join(SANDBOX_WORKSPACE, normalized);
}

function toWorkspaceRelativePath(path: string): string | null {
  const normalized = posix.normalize(path);
  if (normalized === SANDBOX_WORKSPACE) return null;
  if (!normalized.startsWith(`${SANDBOX_WORKSPACE}/`)) return null;
  return normalized.slice(SANDBOX_WORKSPACE.length + 1);
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

  /**
   * Optional URL to fetch the session-host binary from instead of reading it
   * from the local filesystem. Required in environments without filesystem
   * access (e.g. Cloudflare Workers).
   */
  private readonly sessionHostUrl: string | undefined;

  constructor(opts: {
    apiKey: string;
    template?: string;
    maxSessionsPerInstance?: number;
    basePort?: number;
    /** URL to fetch the session-host binary from (for environments without filesystem access). */
    sessionHostUrl?: string;
  }) {
    this.apiKey = opts.apiKey;
    this.template = opts.template ?? "base";
    this.maxSessions = opts.maxSessionsPerInstance ?? DEFAULT_MAX_SESSIONS;
    this.basePort = opts.basePort ?? DEFAULT_BASE_PORT;
    this.sessionHostUrl = opts.sessionHostUrl;
  }

  // ---------------------------------------------------------------------------
  // Instance lifecycle
  // ---------------------------------------------------------------------------

  async start(instanceId: string): Promise<void> {
    console.log(`[E2BRuntime] start("${instanceId}") called`);
    const existing = await this.resolveInstanceSandbox(instanceId);
    console.log(`[E2BRuntime] resolveInstanceSandbox result:`, existing ? `sandbox=${existing.entry.sandboxId}, state=${existing.state}` : "null");
    if (existing) {
      // Resume a paused sandbox — Sandbox.connect auto-resumes
      const sandbox = await Sandbox.connect(existing.entry.sandboxId, { apiKey: this.apiKey });
      // Verify the binary exists (it may be missing if a previous start() failed
      // after creating the sandbox but before uploading the binary).
      const hasBinary = await sandbox.commands.run(`test -x ${SANDBOX_BIN_PATH}`).then(() => true, () => false);
      if (!hasBinary) {
        console.log(`[E2BRuntime] Binary missing in existing sandbox ${existing.entry.sandboxId}, uploading...`);
        await this.uploadSessionHostBinary(sandbox);
      }
      this.instances.set(instanceId, {
        sandboxId: existing.entry.sandboxId,
        ports: this.createPortSlots(instanceId),
      });
      console.log(`[E2BRuntime] Instance "${instanceId}" reconnected (sandbox=${existing.entry.sandboxId})`);
      return;
    }

    // Create a new sandbox
    console.log(`[E2BRuntime] Creating new sandbox with template="${this.template}"...`);
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.create(this.template, {
        apiKey: this.apiKey,
        timeoutMs: 60 * 60 * 1000,
        metadata: { [FLAMECAST_INSTANCE_LABEL]: instanceId },
      });
    } catch (err) {
      console.error(`[E2BRuntime] Sandbox.create failed:`, err instanceof Error ? err.message : err);
      throw err;
    }
    console.log(`[E2BRuntime] Sandbox created: ${sandbox.sandboxId}`);

    try {
      await this.uploadSessionHostBinary(sandbox);
    } catch (err) {
      console.error(`[E2BRuntime] uploadSessionHostBinary failed:`, err instanceof Error ? err.message : err);
      // Kill the orphan sandbox so it doesn't get picked up by resolveInstanceSandbox later
      await Sandbox.kill(sandbox.sandboxId, { apiKey: this.apiKey }).catch(() => {});
      throw err;
    }

    this.instances.set(instanceId, {
      sandboxId: sandbox.sandboxId,
      ports: this.createPortSlots(instanceId),
    });
    console.log(`[E2BRuntime] Instance "${instanceId}" started (sandbox=${sandbox.sandboxId})`);
  }

  /** Upload the session-host binary into a sandbox. */
  private async uploadSessionHostBinary(sandbox: Sandbox): Promise<void> {
    const localBinary = resolveSessionHostBinary();
    if (localBinary) {
      const binaryBlob = new Blob([readFileSync(localBinary)]);
      await sandbox.files.write(SANDBOX_BIN_PATH, binaryBlob);
      await sandbox.commands.run(`chmod +x ${SANDBOX_BIN_PATH}`);
    } else {
      const url = this.sessionHostUrl ?? resolveSessionHostReleaseUrl();
      console.log(`[E2BRuntime] Downloading session-host from ${url}...`);
      try {
        await sandbox.commands.run(
          `curl -sfL -o ${SANDBOX_BIN_PATH} '${url}' && chmod +x ${SANDBOX_BIN_PATH}`,
          { timeoutMs: 30_000 },
        );
      } catch (err) {
        throw new Error(
          `Failed to download session-host binary from ${url}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  async stop(instanceId: string): Promise<void> {
    for (const [sid, session] of this.sessions) {
      if (session.instanceName === instanceId) {
        this.sessions.delete(sid);
      }
    }

    const resolved = await this.resolveInstanceSandbox(instanceId);
    if (!resolved) return;

    try {
      await Sandbox.kill(resolved.entry.sandboxId, { apiKey: this.apiKey });
    } catch {
      // Sandbox may already be gone
    }

    this.instances.delete(instanceId);
    console.log(`[E2BRuntime] Instance "${instanceId}" stopped`);
  }

  async pause(instanceId: string): Promise<void> {
    const resolved = await this.resolveInstanceSandbox(instanceId);
    if (!resolved) throw new Error(`Instance "${instanceId}" not found`);

    await Sandbox.pause(resolved.entry.sandboxId, { apiKey: this.apiKey });
    console.log(`[E2BRuntime] Instance "${instanceId}" paused`);
  }

  async getInstanceStatus(
    instanceId: string,
  ): Promise<"running" | "stopped" | "paused" | undefined> {
    const resolved = await this.resolveInstanceSandbox(instanceId);
    if (!resolved) return undefined;
    if (resolved.state === "paused") return "paused";
    if (resolved.state === "running") return "running";
    return "stopped";
  }

  // ---------------------------------------------------------------------------
  // Session handling
  // ---------------------------------------------------------------------------

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const path = getRequestPath(request);

    if (path.endsWith("/start") && request.method === "POST") {
      return this.handleStart(sessionId, request);
    }

    if (path.endsWith("/terminate") && request.method === "POST") {
      return this.handleTerminate(sessionId, path);
    }

    return this.proxyRequest(sessionId, path, request);
  }

  async fetchInstance(instanceId: string, request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/fs/snapshot" && request.method === "GET") {
      return this.handleInstanceSnapshot(instanceId, request);
    }

    if (path === "/files" && request.method === "GET") {
      return this.handleInstanceFilePreview(instanceId, request);
    }

    return jsonResponse({ error: `Unsupported runtime request: ${request.method} ${path}` }, 404);
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
    const instanceName =
      typeof runtimeMeta.instanceName === "string" ? runtimeMeta.instanceName : undefined;
    const sandboxId = typeof runtimeMeta.sandboxId === "string" ? runtimeMeta.sandboxId : undefined;
    const port = typeof runtimeMeta.port === "number" ? runtimeMeta.port : undefined;
    const hostUrl = typeof runtimeMeta.hostUrl === "string" ? runtimeMeta.hostUrl : undefined;
    const websocketUrl =
      typeof runtimeMeta.websocketUrl === "string" ? runtimeMeta.websocketUrl : undefined;
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
    console.log(`[E2BRuntime] handleStart called for session "${sessionId}"`);
    if (this.sessions.has(sessionId)) {
      return jsonResponse({ error: `Session "${sessionId}" already exists` }, 409);
    }

    try {
      console.log(`[E2BRuntime] Parsing request body...`);
      const parsed: Record<string, unknown> = JSON.parse(await request.text());
      const instanceName =
        typeof parsed.instanceName === "string" ? parsed.instanceName : undefined;
      console.log(`[E2BRuntime] instanceName="${instanceName}", command="${parsed.command}"`);

      if (!instanceName) {
        return jsonResponse(
          { error: "Missing instanceName — create a runtime instance first" },
          400,
        );
      }

      console.log(`[E2BRuntime] Resolving instance sandbox...`);
      const resolved = await this.resolveInstanceSandbox(instanceName);
      if (!resolved) {
        return jsonResponse({ error: `Runtime instance "${instanceName}" not found` }, 404);
      }
      const inst = resolved.entry;
      console.log(`[E2BRuntime] Found sandbox=${inst.sandboxId}, state=${resolved.state}`);

      const slot = inst.ports.find((p) => !p.inUse);
      if (!slot) {
        return jsonResponse(
          {
            error: `No available ports in instance "${instanceName}" (max ${this.maxSessions} sessions)`,
          },
          503,
        );
      }

      // Connect to sandbox and start session-host binary on the assigned port
      console.log(`[E2BRuntime] Connecting to sandbox ${inst.sandboxId}...`);
      const sandbox = await Sandbox.connect(inst.sandboxId, { apiKey: this.apiKey });
      console.log(`[E2BRuntime] Connected. Running binary check...`);

      // Verify the binary exists and is executable (E2B SDK throws CommandExitError on non-zero exit)
      try {
        const checkResult = await sandbox.commands.run(
          `ls -la ${SANDBOX_BIN_PATH} && file ${SANDBOX_BIN_PATH}`,
        );
        console.log(`[E2BRuntime] Binary check: ${checkResult.stdout.trim()}`);
      } catch (checkErr) {
        throw new Error(`Session-host binary not found in sandbox: ${checkErr instanceof Error ? checkErr.message : checkErr}`);
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
      // Use `|| true` to avoid CommandExitError when grep finds no matches
      const checkProc = await sandbox.commands.run(
        `(ps aux | grep session-host | grep -v grep || true); echo "---LOG---"; cat ${logFile} 2>/dev/null || true`,
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

      console.log(`[E2BRuntime] /start request body:`, JSON.stringify(parsed, null, 2));

      const resp = await fetch(`${hostUrl}/start`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(parsed),
      });

      const text = await resp.text();
      console.log(`[E2BRuntime] /start response (${resp.status}):`, text);
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

  private async proxyRequest(sessionId: string, path: string, request: Request): Promise<Response> {
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

  private async handleInstanceSnapshot(instanceId: string, request: Request): Promise<Response> {
    const sandbox = await this.getRunningSandbox(instanceId);
    if (sandbox instanceof Response) return sandbox;

    const showAllFiles = new URL(request.url).searchParams.get("showAllFiles") === "true";
    let entries: RuntimeEntry[];
    try {
      const listedEntries = await sandbox.files.list(SANDBOX_WORKSPACE, { depth: 64 });
      const mappedEntries: RuntimeEntry[] = [];
      for (const entry of listedEntries) {
        const relativePath = toWorkspaceRelativePath(entry.path);
        if (!relativePath) continue;

        mappedEntries.push({
          path: relativePath,
          type: entry.type === "dir" ? "directory" : entry.type === "file" ? "file" : "other",
        });
      }
      entries = mappedEntries;
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : "Failed to read runtime filesystem",
        },
        500,
      );
    }
    if (!showAllFiles) {
      const gitIgnoreContents = await sandbox.files
        .read(posix.join(SANDBOX_WORKSPACE, ".gitignore"), { format: "text" })
        .catch(() => "");
      const rules = parseGitIgnoreRules(gitIgnoreContents);
      entries = entries.filter((entry) => !isGitIgnored(entry.path, rules));
    }

    const maxEntries = 10_000;
    const truncated = entries.length > maxEntries;
    return jsonResponse({
      root: SANDBOX_WORKSPACE,
      entries: truncated ? entries.slice(0, maxEntries) : entries,
      truncated,
      maxEntries,
    });
  }

  private async handleInstanceFilePreview(instanceId: string, request: Request): Promise<Response> {
    const sandbox = await this.getRunningSandbox(instanceId);
    if (sandbox instanceof Response) return sandbox;

    const filePath = new URL(request.url).searchParams.get("path");
    if (!filePath) {
      return jsonResponse({ error: "Missing ?path= parameter" }, 400);
    }

    const resolvedPath = resolveWorkspacePath(filePath);
    if (!resolvedPath) {
      return jsonResponse({ error: "Path outside workspace" }, 403);
    }

    try {
      const info = await sandbox.files.getInfo(resolvedPath);
      if (info.type !== "file") {
        return jsonResponse({ error: `Cannot read: ${filePath}` }, 404);
      }

      const maxChars = 100_000;
      const content = await sandbox.files.read(resolvedPath, { format: "text" });
      return jsonResponse({
        path: filePath,
        content: content.slice(0, maxChars),
        truncated: content.length > maxChars || info.size > maxChars,
        maxChars,
      });
    } catch {
      return jsonResponse({ error: `Cannot read: ${filePath}` }, 404);
    }
  }

  private async getRunningSandbox(instanceId: string): Promise<Sandbox | Response> {
    const resolved = await this.resolveInstanceSandbox(instanceId);
    if (!resolved) {
      return jsonResponse({ error: `Runtime instance "${instanceId}" not found` }, 404);
    }

    if (resolved.state !== "running") {
      return jsonResponse({ error: `Runtime instance "${instanceId}" is not running` }, 409);
    }

    return Sandbox.connect(resolved.entry.sandboxId, { apiKey: this.apiKey });
  }

  private createPortSlots(instanceId: string): PortSlot[] {
    const ports: PortSlot[] = [];
    for (let index = 0; index < this.maxSessions; index += 1) {
      const port = this.basePort + index;
      ports.push({
        port,
        inUse: [...this.sessions.values()].some(
          (session) => session.instanceName === instanceId && session.port === port,
        ),
      });
    }
    return ports;
  }

  private async resolveInstanceSandbox(instanceId: string): Promise<{
    entry: InstanceEntry;
    state: "running" | "paused";
  } | null> {
    const tracked = this.instances.get(instanceId);
    if (tracked) {
      const info = await Sandbox.getFullInfo(tracked.sandboxId, { apiKey: this.apiKey }).catch(
        () => null,
      );
      if (info) {
        const entry = { sandboxId: tracked.sandboxId, ports: this.createPortSlots(instanceId) };
        this.instances.set(instanceId, entry);
        return { entry, state: info.state };
      }
      this.instances.delete(instanceId);
    }

    const paginator = Sandbox.list({
      apiKey: this.apiKey,
      limit: 1,
      query: {
        metadata: { [FLAMECAST_INSTANCE_LABEL]: instanceId },
      },
    });
    if (!paginator.hasNext) return null;

    const sandboxes = await paginator.nextItems().catch(() => []);
    const match = sandboxes.find(
      (sandbox) => sandbox.metadata[FLAMECAST_INSTANCE_LABEL] === instanceId,
    );
    if (!match) return null;

    const entry = { sandboxId: match.sandboxId, ports: this.createPortSlots(instanceId) };
    this.instances.set(instanceId, entry);
    return { entry, state: match.state };
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
          console.log(
            `[E2BRuntime] Health check attempt ${attempts}: ${err instanceof Error ? err.message : "connection failed"}`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `SessionHost at ${hostUrl} not ready after ${timeoutMs}ms (${attempts} attempts)`,
    );
  }
}
