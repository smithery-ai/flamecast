/* oxlint-disable no-type-assertion/no-type-assertion */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import type { Runtime } from "@flamecast/protocol/runtime";

// ---------------------------------------------------------------------------
// Session-host binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the session-host static Go binary.
 *
 * Lookup order:
 *   1. `SESSION_HOST_BINARY` env var (explicit override)
 *   2. Via the @flamecast/session-host-go package dependency
 *      (resolves through node_modules, works in monorepo and standalone)
 */
function resolveSessionHostBinary(): string {
  // 1. Explicit env var
  if (process.env.SESSION_HOST_BINARY) {
    const p = process.env.SESSION_HOST_BINARY;
    if (!existsSync(p)) {
      throw new Error(`SESSION_HOST_BINARY points to "${p}" which does not exist`);
    }
    return p;
  }

  // 2. Resolve via @flamecast/session-host-go package
  // import.meta.resolve gives us the package.json path; the binary is at dist/session-host
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

const CONTAINER_BIN_PATH = "/usr/local/bin/session-host";
const JSON_HEADERS = { "Content-Type": "application/json" };
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_BASE_PORT = 9000;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
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
  private readonly docker: Docker;
  private readonly maxSessions: number;
  private readonly basePort: number;

  /** instanceName → Docker container + port pool */
  private readonly instances = new Map<string, InstanceEntry>();
  /** sessionId → which instance + assigned port */
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(opts?: {
    baseImage?: string;
    docker?: Docker;
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
    const existing = this.instances.get(instanceId);
    if (existing) {
      // Resume a paused or stopped container
      const container = this.docker.getContainer(existing.containerId);
      const info = await container.inspect();
      if (info.State.Paused) {
        await container.unpause();
      } else if (!info.State.Running) {
        await container.start();
      }
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
        Binds: [`${binaryPath}:${CONTAINER_BIN_PATH}:ro`],
        PortBindings: portBindings,
      },
      WorkingDir: "/workspace",
      Labels: { "flamecast.instance": instanceId },
    });

    await container.start();
    const info = await container.inspect();

    if (!info.State.Running) {
      const logs = await container.logs({ stdout: true, stderr: true, tail: 20 });
      await container.remove().catch(() => {});
      throw new Error(
        `Container exited immediately (code=${info.State.ExitCode}). Logs:\n${logs.toString()}`,
      );
    }

    const ports: PortSlot[] = [];
    for (let i = 0; i < this.maxSessions; i++) {
      const containerPort = this.basePort + i;
      const binding = info.NetworkSettings.Ports[`${containerPort}/tcp`];
      const hostPort = parseInt(binding?.[0]?.HostPort ?? "0", 10);
      if (hostPort) {
        ports.push({ containerPort, hostPort, inUse: false });
      }
    }

    this.instances.set(instanceId, { containerId: container.id, ports });
    console.log(
      `[DockerRuntime] Instance "${instanceId}" started (container=${container.id.slice(0, 12)}, ${ports.length} ports)`,
    );
  }

  async stop(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;

    // Clean up session tracking for this instance
    for (const [sid, session] of this.sessions) {
      if (session.instanceName === instanceId) {
        this.sessions.delete(sid);
      }
    }

    try {
      const container = this.docker.getContainer(inst.containerId);
      await container.kill().catch(() => {});
      await container.remove().catch(() => {});
    } catch {
      // Container may already be gone
    }

    this.instances.delete(instanceId);
    console.log(`[DockerRuntime] Instance "${instanceId}" stopped`);
  }

  async pause(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance "${instanceId}" not found`);

    const container = this.docker.getContainer(inst.containerId);
    await container.pause();
    console.log(`[DockerRuntime] Instance "${instanceId}" paused`);
  }

  async getInstanceStatus(
    instanceId: string,
  ): Promise<"running" | "stopped" | "paused" | undefined> {
    const inst = this.instances.get(instanceId);
    if (!inst) return undefined;

    try {
      const container = this.docker.getContainer(inst.containerId);
      const info = await container.inspect();
      if (info.State.Paused) return "paused";
      if (info.State.Running) return "running";
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
    const instanceName = runtimeMeta.instanceName as string | undefined;
    const containerId = runtimeMeta.containerId as string | undefined;
    const containerPort = runtimeMeta.containerPort as number | undefined;
    const hostPort = runtimeMeta.hostPort as number | undefined;
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
      const inst = this.instances.get(instanceName)!;
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
      const parsed = JSON.parse(await request.text()) as Record<string, unknown>;
      const instanceName = parsed.instanceName as string | undefined;

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
      const container = this.docker.getContainer(inst.containerId);
      const exec = await container.exec({
        Cmd: [CONTAINER_BIN_PATH],
        Env: [`SESSION_HOST_PORT=${slot.containerPort}`],
        AttachStdout: false,
        AttachStderr: false,
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
      parsed.workspace = "/workspace";
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
