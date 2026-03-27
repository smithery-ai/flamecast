import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import type { Runtime } from "@flamecast/protocol/runtime";
import { resolveSessionHostBinary as resolveSessionHostBinaryShared } from "@flamecast/session-host-go/resolve";
import { getRequestPath } from "./request-path.js";

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

interface PortSlot {
  containerPort: number;
  hostPort: number;
  inUse: boolean;
}

interface InstanceEntry {
  containerId: string;
  ports: PortSlot[];
}

interface SessionEntry {
  instanceName: string;
  containerPort: number;
  hostPort: number;
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
 * image and a pre-allocated port range. Sessions are started inside the
 * container via `docker exec`, each running its own session-host binary on a
 * unique port.
 *
 * `pause(instanceId)` freezes the container (and all session-hosts inside it).
 * `stop(instanceId)` tears down the container entirely.
 */
export class DockerRuntime implements Runtime {
  private readonly baseImage: string;
  private readonly docker: DockerClient;
  private readonly maxSessions: number;
  private readonly basePort: number;

  /** instanceName → Docker container + port pool */
  private readonly instances = new Map<string, InstanceEntry>();
  /** sessionId → which instance + assigned port */
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(opts?: {
    baseImage?: string;
    docker?: DockerClient;
    maxSessionsPerInstance?: number;
    baseContainerPort?: number;
  }) {
    this.baseImage = opts?.baseImage ?? "node:22-slim";
    this.docker = opts?.docker ?? new Docker();
    this.maxSessions = opts?.maxSessionsPerInstance ?? DEFAULT_MAX_SESSIONS;
    this.basePort = opts?.baseContainerPort ?? DEFAULT_BASE_PORT;
  }

  // ---------------------------------------------------------------------------
  // Instance lifecycle
  // ---------------------------------------------------------------------------

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

    const exposedPorts: Record<string, Record<string, never>> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    for (let i = 0; i < this.maxSessions; i++) {
      const key = `${this.basePort + i}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: "0" }];
    }

    const container = await this.docker.createContainer({
      Image: this.baseImage,
      Cmd: ["tail", "-f", "/dev/null"],
      ExposedPorts: exposedPorts,
      Env: ["RUNTIME_SETUP_ENABLED=1"],
      HostConfig: {
        PortBindings: portBindings,
      },
      WorkingDir: DEFAULT_CONTAINER_WORKSPACE,
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
      await this.bootstrapContainer(container, binaryPath, resolveContainerWorkspaceRoot(info));
      info = await container.inspect();
    } catch (error) {
      await container.kill().catch(() => {});
      await container.remove().catch(() => {});
      throw error;
    }

    const ports = this.extractPortSlots(instanceId, info);
    this.instances.set(instanceId, {
      containerId: container.id,
      ports,
    });
    console.log(
      `[DockerRuntime] Instance "${instanceId}" started (container=${container.id.slice(0, 12)}, ${ports.length} ports)`,
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
      containerId: inst?.containerId,
      containerPort: session.containerPort,
      hostPort: session.hostPort,
    };
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
    const containerPort =
      typeof runtimeMeta.containerPort === "number" ? runtimeMeta.containerPort : undefined;
    const hostPort = typeof runtimeMeta.hostPort === "number" ? runtimeMeta.hostPort : undefined;
    if (!instanceName || !containerId || !containerPort || !hostPort) return false;

    try {
      // Ensure instance is tracked
      if (!this.instances.has(instanceName)) {
        const container = this.docker.getContainer(containerId);
        const info = await container.inspect();
        if (!info.State.Running && !info.State.Paused) return false;

        // Reconstruct port pool from container info
        const ports: PortSlot[] = [];
        for (let i = 0; i < this.maxSessions; i++) {
          const cp = this.basePort + i;
          const binding = info.NetworkSettings.Ports[`${cp}/tcp`];
          const hp = parseInt(binding?.[0]?.HostPort ?? "0", 10);
          if (hp) {
            ports.push({ containerPort: cp, hostPort: hp, inUse: false });
          }
        }
        this.instances.set(instanceName, { containerId, ports });
      }

      // Verify session-host is responsive
      const resp = await fetch(`http://localhost:${hostPort}/health`).catch(() => null);
      if (!resp?.ok) return false;

      // Mark the port as in use
      const inst = this.instances.get(instanceName);
      if (!inst) return false;
      const slot = inst.ports.find((p) => p.containerPort === containerPort);
      if (slot) slot.inUse = true;

      this.sessions.set(sessionId, { instanceName, containerPort, hostPort });
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
      const inst = resolved.entry;

      // Allocate a port
      const slot = inst.ports.find((p) => !p.inUse);
      if (!slot) {
        return jsonResponse(
          {
            error: `No available ports in instance "${instanceName}" (max ${this.maxSessions} sessions)`,
          },
          503,
        );
      }

      // Exec session-host inside the container
      const workspaceRoot = resolveContainerWorkspaceRoot(resolved.info);
      const exec = await resolved.container.exec({
        Cmd: [CONTAINER_BIN_PATH],
        Env: [`SESSION_HOST_PORT=${slot.containerPort}`],
        AttachStdout: false,
        AttachStderr: false,
        WorkingDir: workspaceRoot,
      });
      await exec.start({ Detach: true });

      slot.inUse = true;
      this.sessions.set(sessionId, {
        instanceName,
        containerPort: slot.containerPort,
        hostPort: slot.hostPort,
      });

      await this.waitForReady(slot.hostPort);

      // Forward to session-host (strip instanceName, override workspace)
      parsed.workspace = workspaceRoot;
      delete parsed.instanceName;

      const resp = await fetch(`http://localhost:${slot.hostPort}/start`, {
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

      result.hostUrl = `http://localhost:${slot.hostPort}`;
      result.websocketUrl = `ws://localhost:${slot.hostPort}`;

      return new Response(JSON.stringify(result), {
        status: resp.status,
        headers: JSON_HEADERS,
      });
    } catch (err) {
      // Clean up on failure
      const session = this.sessions.get(sessionId);
      if (session) {
        const inst = this.instances.get(session.instanceName);
        const slot = inst?.ports.find((p) => p.containerPort === session.containerPort);
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

    const resp = await fetch(`http://localhost:${session.hostPort}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
    });

    // Free the port
    const inst = this.instances.get(session.instanceName);
    const slot = inst?.ports.find((p) => p.containerPort === session.containerPort);
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
    const resp = await fetch(`http://localhost:${session.hostPort}${path}`, {
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
    const resolved = await this.getRunningContainer(instanceId);
    if (resolved instanceof Response) return resolved;

    const showAllFiles = new URL(request.url).searchParams.get("showAllFiles") === "true";
    const workspaceRoot = resolveContainerWorkspaceRoot(resolved.info);
    const listResult = await this.execInContainer(resolved.container, [
      "sh",
      "-lc",
      `find ${shellEscape(workspaceRoot)} -mindepth 1 -printf '%y\t%P\n'`,
    ]);
    if (listResult.exitCode !== 0) {
      return jsonResponse(
        { error: listResult.stderr.trim() || "Failed to read runtime filesystem" },
        500,
      );
    }

    let entries = parseFindOutput(listResult.stdout);
    if (!showAllFiles) {
      const gitIgnoreResult = await this.execInContainer(resolved.container, [
        "sh",
        "-lc",
        `cat ${shellEscape(posix.join(workspaceRoot, ".gitignore"))}`,
      ]);
      const rules = parseGitIgnoreRules(
        gitIgnoreResult.exitCode === 0 ? gitIgnoreResult.stdout : "",
      );
      entries = entries.filter((entry) => !isGitIgnored(entry.path, rules));
    }

    const maxEntries = 10_000;
    const truncated = entries.length > maxEntries;
    return jsonResponse({
      root: workspaceRoot,
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

  private extractPortSlots(instanceId: string, info: DockerContainerInspectInfo): PortSlot[] {
    const ports: PortSlot[] = [];
    for (let index = 0; index < this.maxSessions; index += 1) {
      const containerPort = this.basePort + index;
      const binding = info.NetworkSettings.Ports[`${containerPort}/tcp`];
      const hostPort = parseInt(binding?.[0]?.HostPort ?? "0", 10);
      if (hostPort) {
        ports.push({
          containerPort,
          hostPort,
          inUse: [...this.sessions.values()].some(
            (session) =>
              session.instanceName === instanceId && session.containerPort === containerPort,
          ),
        });
      }
    }
    return ports;
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

    const entry = {
      containerId,
      ports: this.extractPortSlots(instanceId, info),
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
    throw new Error(`SessionHost not ready after ${timeoutMs}ms`);
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
