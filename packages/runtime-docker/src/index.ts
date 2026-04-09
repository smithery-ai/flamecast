import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import type { Runtime } from "@flamecast/protocol/runtime";
import { resolveSessionHostBinary as resolveSessionHostBinaryShared } from "@flamecast/session-host-go/resolve";

// ---------------------------------------------------------------------------
// Session-host binary resolution
// ---------------------------------------------------------------------------

/** Resolve the session-host binary (host architecture). Throws if not found. */
function resolveSessionHostBinary(): string {
  const binary = resolveSessionHostBinaryShared();
  if (!binary) {
    throw new Error(
      "No session-host binary found. Install Go and run: " +
        "pnpm --filter @flamecast/session-host-go run postinstall",
    );
  }
  return binary;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTAINER_BIN_PATH = "/usr/local/bin/session-host";
const DEFAULT_CONTAINER_WORKSPACE = "/workspace";
const JSON_HEADERS = { "Content-Type": "application/json" };
const DEFAULT_RUNTIME_HOST_PORT = 9000;
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

function parseFindOutput(stdout: string): RuntimeEntry[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const [kind, path] = line.split("\t", 2);
      if (!kind || !path) return [];
      return [
        {
          path,
          type:
            kind === "d" ? "directory" : kind === "f" ? "file" : kind === "l" ? "symlink" : "other",
        } satisfies RuntimeEntry,
      ];
    });
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function resolveWorkspacePath(workspaceRoot: string, filePath: string): string | null {
  if (!filePath || filePath.includes("\0")) return null;
  const normalized = posix.normalize(filePath);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return null;
  }
  return posix.join(workspaceRoot, normalized);
}

function resolveContainerWorkspaceRoot(info: DockerContainerInspectInfo): string {
  const configured = info.Config?.WorkingDir?.trim();
  if (!configured) return DEFAULT_CONTAINER_WORKSPACE;
  const normalized = posix.normalize(configured);
  if (normalized === "." || normalized === "") return DEFAULT_CONTAINER_WORKSPACE;
  return normalized.startsWith("/") ? normalized : posix.join("/", normalized);
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface InstanceEntry {
  containerId: string;
  /** The single runtime-host port for this instance. */
  runtimeHostPort: number;
  /** Host-mapped port for the single runtime-host. */
  hostPort: number;
}

/** Tracks which instance a session belongs to. */
interface SessionEntry {
  instanceName: string;
}

type DockerContainerInspectInfo = {
  Config?: {
    WorkingDir?: string;
  };
  State: {
    Running?: boolean;
    Paused?: boolean;
    ExitCode?: number | null;
  };
  NetworkSettings: {
    Ports: Record<string, Array<{ HostPort: string }> | null | undefined>;
  };
};

type DockerExecClient = {
  inspect(): Promise<{ ExitCode?: number | null }>;
  start(opts: {
    hijack?: boolean;
    stdin?: boolean;
    Detach?: boolean;
  }): Promise<NodeJS.ReadWriteStream>;
};

type DockerContainerClient = {
  inspect(): Promise<DockerContainerInspectInfo>;
  start(): Promise<void>;
  unpause(): Promise<void>;
  pause(): Promise<void>;
  kill(): Promise<void>;
  remove(): Promise<void>;
  logs(opts: { stdout?: boolean; stderr?: boolean; tail?: number }): Promise<Buffer>;
  exec(opts: {
    Cmd: string[];
    Env?: string[];
    AttachStdout: boolean;
    AttachStderr: boolean;
    WorkingDir?: string;
  }): Promise<DockerExecClient>;
  putArchive(
    file: string | Buffer | NodeJS.ReadableStream,
    options: { path: string },
  ): Promise<NodeJS.ReadWriteStream>;
};

type DockerCreatedContainerClient = DockerContainerClient & {
  id: string;
};

type DockerImageClient = {
  inspect(): Promise<unknown>;
};

type DockerClient = {
  createContainer(opts: Record<string, unknown>): Promise<DockerCreatedContainerClient>;
  getContainer(id: string): DockerContainerClient;
  getImage(image: string): DockerImageClient;
  listContainers(opts: {
    all: boolean;
  }): Promise<Array<{ Id: string; Labels?: Record<string, string> }>>;
  pull(image: string): Promise<NodeJS.ReadableStream>;
  modem: {
    demuxStream(
      stream: NodeJS.ReadableStream,
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
    ): void;
    followProgress(stream: NodeJS.ReadableStream, onFinished: (err: Error | null) => void): void;
  };
};

// ---------------------------------------------------------------------------
// DockerRuntime
// ---------------------------------------------------------------------------

/**
 * DockerRuntime — one Docker container per runtime instance.
 *
 * When `start(instanceId)` is called, a container is created with the base
 * image and a single runtime-host process is started on a fixed port. Sessions
 * are managed by the runtime-host via its multi-session HTTP and WebSocket API.
 *
 * `pause(instanceId)` freezes the container (and the runtime-host inside it).
 * `stop(instanceId)` tears down the container entirely.
 */
export class DockerRuntime implements Runtime {
  private readonly baseImage: string;
  private readonly docker: DockerClient;
  private readonly runtimeHostPort: number;
  private readonly workingDir: string;

  /** instanceName → Docker container + runtime-host port */
  private readonly instances = new Map<string, InstanceEntry>();
  /** sessionId → which instance it belongs to */
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(opts?: {
    baseImage?: string;
    docker?: DockerClient;
    runtimeHostPort?: number;
    /** Working directory inside the container. Defaults to `/workspace`. */
    cwd?: string;
  }) {
    this.baseImage = opts?.baseImage ?? "node:22-slim";
    this.docker = opts?.docker ?? new Docker();
    this.runtimeHostPort = opts?.runtimeHostPort ?? DEFAULT_RUNTIME_HOST_PORT;
    this.workingDir = opts?.cwd ?? DEFAULT_CONTAINER_WORKSPACE;
  }

  // ---------------------------------------------------------------------------
  // Instance lifecycle
  // ---------------------------------------------------------------------------

  async autoStart(): Promise<void> {
    throw new Error("DockerRuntime does not support auto-start");
  }

  async start(instanceId: string): Promise<void> {
    const existing = await this.resolveInstanceContainer(instanceId);
    if (existing) {
      // Resume a paused or stopped container
      if (existing.info.State.Paused) {
        await existing.container.unpause();
      } else if (!existing.info.State.Running) {
        await existing.container.start();
      }
      await this.inspectContainer(instanceId, existing.entry.containerId);
      return;
    }

    // Create a new container for this instance
    const binaryPath = resolveSessionHostBinary();
    await this.ensureImage(this.baseImage);

    const portKey = `${this.runtimeHostPort}/tcp`;
    const container = await this.docker.createContainer({
      Image: this.baseImage,
      Cmd: ["tail", "-f", "/dev/null"],
      ExposedPorts: { [portKey]: {} },
      Env: ["RUNTIME_SETUP_ENABLED=1"],
      HostConfig: {
        PortBindings: { [portKey]: [{ HostPort: "0" }] },
      },
      WorkingDir: this.workingDir,
      Labels: { [FLAMECAST_INSTANCE_LABEL]: instanceId },
    });

    await container.start();
    let info = await container.inspect();

    if (!info.State.Running) {
      const logs = await container.logs({ stdout: true, stderr: true, tail: 20 });
      await container.remove().catch(() => {});
      throw new Error(
        `Container exited immediately (code=${info.State.ExitCode}). Logs:\n${logs.toString()}`,
      );
    }

    try {
      const workspaceRoot = resolveContainerWorkspaceRoot(info);
      await this.bootstrapContainer(container, binaryPath, workspaceRoot);

      // Start the single runtime-host process
      const exec = await container.exec({
        Cmd: [CONTAINER_BIN_PATH],
        Env: [`SESSION_HOST_PORT=${this.runtimeHostPort}`],
        AttachStdout: false,
        AttachStderr: false,
        WorkingDir: workspaceRoot,
      });
      await exec.start({ Detach: true });

      info = await container.inspect();
    } catch (error) {
      await container.kill().catch(() => {});
      await container.remove().catch(() => {});
      throw error;
    }

    const hostPort = this.extractHostPort(info);
    this.instances.set(instanceId, {
      containerId: container.id,
      runtimeHostPort: this.runtimeHostPort,
      hostPort,
    });

    // Wait for the runtime-host to be ready
    await this.waitForReady(hostPort);

    console.log(
      `[DockerRuntime] Instance "${instanceId}" started (container=${container.id.slice(0, 12)}, port=${hostPort})`,
    );
  }

  async stop(instanceId: string): Promise<void> {
    // Clean up session tracking for this instance
    for (const [sid, session] of this.sessions) {
      if (session.instanceName === instanceId) {
        this.sessions.delete(sid);
      }
    }

    const resolved = await this.resolveInstanceContainer(instanceId);
    if (!resolved) return;

    try {
      await resolved.container.kill().catch(() => {});
      await resolved.container.remove().catch(() => {});
    } catch {
      // Container may already be gone
    }

    this.instances.delete(instanceId);
    console.log(`[DockerRuntime] Instance "${instanceId}" stopped`);
  }

  async pause(instanceId: string): Promise<void> {
    const resolved = await this.resolveInstanceContainer(instanceId);
    if (!resolved) throw new Error(`Instance "${instanceId}" not found`);

    await resolved.container.pause();
    console.log(`[DockerRuntime] Instance "${instanceId}" paused`);
  }

  async getInstanceStatus(
    instanceId: string,
  ): Promise<"running" | "stopped" | "paused" | undefined> {
    const resolved = await this.resolveInstanceContainer(instanceId);
    if (!resolved) return undefined;
    if (resolved.info.State.Paused) return "paused";
    if (resolved.info.State.Running) return "running";
    return "stopped";
  }

  getWebsocketUrl(instanceId: string): string | undefined {
    const entry = this.instances.get(instanceId);
    if (!entry) return undefined;
    return `ws://localhost:${entry.hostPort}`;
  }

  // ---------------------------------------------------------------------------
  // Session handling — route to the single runtime-host
  // ---------------------------------------------------------------------------

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathWithQuery = `${url.pathname}${url.search}`;

    if (url.pathname.endsWith("/start") && request.method === "POST") {
      return this.handleStart(sessionId, request);
    }

    // All other session requests proxy to /sessions/{sessionId}{path}
    return this.proxySessionRequest(sessionId, pathWithQuery, request);
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

  getRuntimeMeta(_sessionId: string): Record<string, unknown> | null {
    // Find which instance this session belongs to by checking runtime-host health
    // For now, return the first instance (most common case: one instance)
    for (const [instanceName, entry] of this.instances) {
      return {
        instanceName,
        containerId: entry.containerId,
        hostPort: entry.hostPort,
      };
    }
    return null;
  }

  async reconnect(
    sessionId: string,
    runtimeMeta: Record<string, unknown> | null,
  ): Promise<boolean> {
    if (!runtimeMeta) return false;
    const instanceName =
      typeof runtimeMeta.instanceName === "string" ? runtimeMeta.instanceName : undefined;
    const containerId =
      typeof runtimeMeta.containerId === "string" ? runtimeMeta.containerId : undefined;
    const hostPort = typeof runtimeMeta.hostPort === "number" ? runtimeMeta.hostPort : undefined;
    if (!instanceName || !containerId || !hostPort) return false;

    try {
      // Ensure instance is tracked
      if (!this.instances.has(instanceName)) {
        const container = this.docker.getContainer(containerId);
        const info = await container.inspect();
        if (!info.State.Running && !info.State.Paused) return false;

        this.instances.set(instanceName, {
          containerId,
          runtimeHostPort: this.runtimeHostPort,
          hostPort,
        });
      }

      // Verify the runtime-host is responsive and the session exists
      const resp = await fetch(`http://localhost:${hostPort}/sessions/${sessionId}/health`).catch(
        () => null,
      );
      if (!resp?.ok) return false;

      this.sessions.set(sessionId, { instanceName });
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
    try {
      const parsed: Record<string, unknown> = JSON.parse(await request.text());
      const instanceName =
        typeof parsed.instanceName === "string" ? parsed.instanceName : undefined;

      if (!instanceName) {
        return jsonResponse(
          { error: "Missing instanceName — create a runtime instance first" },
          400,
        );
      }

      const resolved = await this.resolveInstanceContainer(instanceName);
      if (!resolved) {
        return jsonResponse({ error: `Runtime instance "${instanceName}" not found` }, 404);
      }

      const workspaceRoot = resolveContainerWorkspaceRoot(resolved.info);

      // Forward to runtime-host at /sessions/{sessionId}/start
      parsed.workspace = workspaceRoot;
      delete parsed.instanceName;

      const resp = await fetch(
        `http://localhost:${resolved.entry.hostPort}/sessions/${sessionId}/start`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(parsed),
        },
      );

      const text = await resp.text();
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error(
          `RuntimeHost /sessions/${sessionId}/start failed (${resp.status}): ${text}`,
        );
      }

      if (!resp.ok) {
        throw new Error(
          `RuntimeHost /sessions/${sessionId}/start failed (${resp.status}): ${result.error ?? text}`,
        );
      }

      // Track session → instance mapping
      this.sessions.set(sessionId, { instanceName });

      // Inject the host-visible URLs (shared across all sessions on this instance)
      result.hostUrl = `http://localhost:${resolved.entry.hostPort}`;
      result.websocketUrl = `ws://localhost:${resolved.entry.hostPort}`;

      return new Response(JSON.stringify(result), {
        status: resp.status,
        headers: JSON_HEADERS,
      });
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : "Failed to start session" },
        500,
      );
    }
  }

  private async proxySessionRequest(
    sessionId: string,
    path: string,
    request: Request,
  ): Promise<Response> {
    const entry = this.getInstanceForSession(sessionId);
    if (!entry) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    const body = request.method !== "GET" ? await request.text() : undefined;
    const resp = await fetch(`http://localhost:${entry.hostPort}/sessions/${sessionId}${path}`, {
      method: request.method,
      headers: JSON_HEADERS,
      body,
    });

    return new Response(await resp.text(), {
      status: resp.status,
      headers: JSON_HEADERS,
    });
  }

  private getInstanceForSession(sessionId: string): InstanceEntry | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return this.instances.get(session.instanceName) ?? null;
  }

  private async handleInstanceSnapshot(instanceId: string, request: Request): Promise<Response> {
    const resolved = await this.getRunningContainer(instanceId);
    if (resolved instanceof Response) return resolved;

    const url = new URL(request.url);
    const showAllFiles = url.searchParams.get("showAllFiles") === "true";
    const workspaceRoot = resolveContainerWorkspaceRoot(resolved.info);
    const requestedPath = url.searchParams.get("path");
    const targetDir = requestedPath ? posix.resolve(requestedPath) : workspaceRoot;

    const listResult = await this.execInContainer(resolved.container, [
      "sh",
      "-lc",
      `find -L ${shellEscape(targetDir)} -mindepth 1 -maxdepth 1 -printf '%y\t%f\n'`,
    ]);
    if (listResult.exitCode !== 0) {
      return jsonResponse(
        { error: listResult.stderr.trim() || "Failed to read runtime filesystem" },
        500,
      );
    }

    let entries = parseFindOutput(listResult.stdout);
    if (!showAllFiles) {
      // Apply .gitignore rules from the directory being listed
      const gitIgnoreResult = await this.execInContainer(resolved.container, [
        "sh",
        "-lc",
        `cat ${shellEscape(posix.join(targetDir, ".gitignore"))}`,
      ]);
      const rules = parseGitIgnoreRules(
        gitIgnoreResult.exitCode === 0 ? gitIgnoreResult.stdout : "",
      );
      if (rules.length > 0) {
        entries = entries.filter((entry) => !isGitIgnored(entry.path, rules));
      }
    }

    const maxEntries = 10_000;
    const truncated = entries.length > maxEntries;
    return jsonResponse({
      root: workspaceRoot,
      path: targetDir,
      entries: truncated ? entries.slice(0, maxEntries) : entries,
      truncated,
      maxEntries,
    });
  }

  private async handleInstanceFilePreview(instanceId: string, request: Request): Promise<Response> {
    const resolved = await this.getRunningContainer(instanceId);
    if (resolved instanceof Response) return resolved;

    const filePath = new URL(request.url).searchParams.get("path");
    if (!filePath) {
      return jsonResponse({ error: "Missing ?path= parameter" }, 400);
    }

    const workspaceRoot = resolveContainerWorkspaceRoot(resolved.info);
    const resolvedPath = resolveWorkspacePath(workspaceRoot, filePath);
    if (!resolvedPath) {
      return jsonResponse({ error: "Path outside workspace" }, 403);
    }

    const sizeResult = await this.execInContainer(resolved.container, [
      "sh",
      "-lc",
      `wc -c < ${shellEscape(resolvedPath)}`,
    ]);
    if (sizeResult.exitCode !== 0) {
      return jsonResponse({ error: `Cannot read: ${filePath}` }, 404);
    }

    const contentResult = await this.execInContainer(resolved.container, [
      "sh",
      "-lc",
      `head -c 100000 ${shellEscape(resolvedPath)}`,
    ]);
    if (contentResult.exitCode !== 0) {
      return jsonResponse({ error: `Cannot read: ${filePath}` }, 404);
    }

    const maxChars = 100_000;
    const rawSize = Number.parseInt(sizeResult.stdout.trim(), 10);
    const truncated = Number.isFinite(rawSize) ? rawSize > maxChars : false;
    return jsonResponse({
      path: filePath,
      content: contentResult.stdout,
      truncated,
      maxChars,
    });
  }

  private async getRunningContainer(instanceId: string): Promise<
    | {
        container: DockerContainerClient;
        info: DockerContainerInspectInfo;
      }
    | Response
  > {
    const resolved = await this.resolveInstanceContainer(instanceId);
    if (!resolved) {
      return jsonResponse({ error: `Runtime instance "${instanceId}" not found` }, 404);
    }

    if (!resolved.info.State.Running || resolved.info.State.Paused) {
      return jsonResponse({ error: `Runtime instance "${instanceId}" is not running` }, 409);
    }
    return { container: resolved.container, info: resolved.info };
  }

  private async execInContainer(
    container: DockerContainerClient,
    cmd: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdoutText = "";
    let stderrText = "";

    stdout.on("data", (chunk: Buffer) => {
      stdoutText += chunk.toString("utf8");
    });
    stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

    this.docker.modem.demuxStream(stream, stdout, stderr);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });

    const result = await exec.inspect();
    return {
      exitCode: result.ExitCode ?? 1,
      stdout: stdoutText,
      stderr: stderrText,
    };
  }

  private async bootstrapContainer(
    container: DockerContainerClient,
    binaryPath: string,
    workspaceRoot: string,
  ): Promise<void> {
    await container.putArchive(createTarArchive("session-host", readFileSync(binaryPath), 0o755), {
      path: posix.dirname(CONTAINER_BIN_PATH),
    });

    const prepareResult = await this.execInContainer(container, [
      "sh",
      "-lc",
      `mkdir -p ${shellEscape(workspaceRoot)} && chmod +x ${shellEscape(CONTAINER_BIN_PATH)}`,
    ]);
    if (prepareResult.exitCode !== 0) {
      throw new Error(prepareResult.stderr.trim() || "Failed to bootstrap Docker runtime");
    }
  }

  private extractHostPort(info: DockerContainerInspectInfo): number {
    const binding = info.NetworkSettings.Ports[`${this.runtimeHostPort}/tcp`];
    const hostPort = parseInt(binding?.[0]?.HostPort ?? "0", 10);
    if (!hostPort) {
      throw new Error("Failed to extract host port for runtime-host");
    }
    return hostPort;
  }

  private async inspectContainer(
    instanceId: string,
    containerId: string,
  ): Promise<{
    container: DockerContainerClient;
    info: DockerContainerInspectInfo;
    entry: InstanceEntry;
  } | null> {
    const container = this.docker.getContainer(containerId);
    const info = await container.inspect().catch(() => null);
    if (!info) return null;

    const hostPort = this.extractHostPort(info);
    const entry: InstanceEntry = {
      containerId,
      runtimeHostPort: this.runtimeHostPort,
      hostPort,
    };
    this.instances.set(instanceId, entry);
    return { container, info, entry };
  }

  private async resolveInstanceContainer(instanceId: string): Promise<{
    container: DockerContainerClient;
    info: DockerContainerInspectInfo;
    entry: InstanceEntry;
  } | null> {
    const tracked = this.instances.get(instanceId);
    if (tracked) {
      const resolved = await this.inspectContainer(instanceId, tracked.containerId);
      if (resolved) return resolved;
      this.instances.delete(instanceId);
    }

    const containers = await this.docker.listContainers({ all: true });
    const match = containers.find(
      (container) => container.Labels?.[FLAMECAST_INSTANCE_LABEL] === instanceId,
    );
    if (!match?.Id) return null;
    return this.inspectContainer(instanceId, match.Id);
  }

  // ---------------------------------------------------------------------------
  // Image management
  // ---------------------------------------------------------------------------

  /** Pull the image if it doesn't exist locally. */
  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return; // Already available
    } catch {
      // Not found locally — pull it
    }

    console.log(`[DockerRuntime] Pulling image ${image}...`);
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Readiness check
  // ---------------------------------------------------------------------------

  private async waitForReady(port: number, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`http://localhost:${port}/health`);
        if (resp.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`RuntimeHost not ready after ${timeoutMs}ms`);
  }
}

function createTarArchive(fileName: string, contents: Buffer, mode: number): Buffer {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, fileName, 0, 100);
  writeTarOctal(header, mode, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, contents.length, 124, 12);
  writeTarOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);

  const padding = (512 - (contents.length % 512)) % 512;
  return Buffer.concat([header, contents, Buffer.alloc(padding), Buffer.alloc(1024)]);
}

function writeTarOctal(header: Buffer, value: number, offset: number, width: number): void {
  const encoded = `${value.toString(8).padStart(width - 1, "0")}\0`;
  Buffer.from(encoded, "ascii").copy(header, offset, 0, width);
}

function writeTarString(header: Buffer, value: string, offset: number, width: number): void {
  Buffer.from(value, "ascii").copy(header, offset, 0, width);
}
