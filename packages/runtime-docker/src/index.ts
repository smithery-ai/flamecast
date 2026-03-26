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

const CONTAINER_PORT = "8080";
const CONTAINER_BIN_PATH = "/usr/local/bin/session-host";
const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// ---------------------------------------------------------------------------
// DockerRuntime
// ---------------------------------------------------------------------------

/**
 * DockerRuntime — spawns a new container per session.
 *
 * Bind-mounts the session-host static Go binary into any user-provided base
 * image. The binary is statically linked and has zero dependencies, so it
 * works on any Linux distro (Debian, Alpine, Ubuntu, etc.) without requiring
 * Node.js or any other runtime.
 *
 * This avoids:
 *   - Dockerfile generation overhead
 *   - CMD/entrypoint conflicts with user images
 *   - Runtime dependencies in the base image
 */
export class DockerRuntime implements Runtime {
  private readonly baseImage: string;
  private readonly docker: Docker;
  private readonly containers = new Map<string, { containerId: string; port: number }>();

  constructor(opts?: { baseImage?: string; docker?: Docker }) {
    this.baseImage = opts?.baseImage ?? "node:22-slim";
    this.docker = opts?.docker ?? new Docker();
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

  getRuntimeMeta(sessionId: string): Record<string, unknown> | null {
    const entry = this.containers.get(sessionId);
    if (!entry) return null;
    return { containerId: entry.containerId, port: entry.port };
  }

  async reconnect(
    sessionId: string,
    runtimeMeta: Record<string, unknown> | null,
  ): Promise<boolean> {
    if (!runtimeMeta) return false;
    const containerId = runtimeMeta.containerId as string | undefined;
    const port = runtimeMeta.port as number | undefined;
    if (!containerId || !port) return false;

    try {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();
      if (!info.State.Running) return false;

      // Verify the session-host inside the container is responsive
      const resp = await fetch(`http://localhost:${port}/health`).catch(() => null);
      if (!resp?.ok) return false;

      this.containers.set(sessionId, { containerId, port });
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.containers.values()].map(async (entry) => {
        const c = this.docker.getContainer(entry.containerId);
        await c.kill().catch(() => {});
        await c.remove().catch(() => {});
      }),
    );
    this.containers.clear();
  }

  // ---------------------------------------------------------------------------
  // Request handlers
  // ---------------------------------------------------------------------------

  private async handleStart(sessionId: string, request: Request): Promise<Response> {
    if (this.containers.has(sessionId)) {
      return jsonResponse({ error: `Session "${sessionId}" already exists` }, 409);
    }

    try {
      const parsed = JSON.parse(await request.text()) as Record<string, unknown>;
      const binaryPath = resolveSessionHostBinary();

      console.log(
        `[DockerRuntime] Starting container (image=${this.baseImage}, binary=${binaryPath})`,
      );

      await this.ensureImage(this.baseImage);

      const container = await this.docker.createContainer({
        Image: this.baseImage,
        Cmd: [CONTAINER_BIN_PATH],
        ExposedPorts: { [`${CONTAINER_PORT}/tcp`]: {} },
        Env: [`SESSION_HOST_PORT=${CONTAINER_PORT}`, "RUNTIME_SETUP_ENABLED=1"],
        HostConfig: {
          Binds: [`${binaryPath}:${CONTAINER_BIN_PATH}:ro`],
          PortBindings: { [`${CONTAINER_PORT}/tcp`]: [{ HostPort: "0" }] },
        },
        WorkingDir: "/workspace",
      });

      await container.start();

      const info = await container.inspect();

      // Check if the container is actually running
      if (!info.State.Running) {
        const logs = await container.logs({ stdout: true, stderr: true, tail: 20 });
        await container.remove().catch(() => {});
        throw new Error(
          `Container exited immediately (code=${info.State.ExitCode}). ` +
            `Logs:\n${logs.toString()}`,
        );
      }

      const portBindings = info.NetworkSettings.Ports[`${CONTAINER_PORT}/tcp`];
      const port = parseInt(portBindings?.[0]?.HostPort ?? "0", 10);

      if (!port) {
        const logs = await container.logs({ stdout: true, stderr: true, tail: 20 });
        await container.kill().catch(() => {});
        await container.remove().catch(() => {});
        throw new Error(`Failed to get container port. Logs:\n${logs.toString()}`);
      }

      this.containers.set(sessionId, { containerId: container.id, port });
      await this.waitForReady(port);

      // Override workspace to the container's agent workspace.
      parsed.workspace = "/workspace";

      const resp = await fetch(`http://localhost:${port}/start`, {
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

      result.hostUrl = `http://localhost:${port}`;
      result.websocketUrl = `ws://localhost:${port}`;

      return new Response(JSON.stringify(result), {
        status: resp.status,
        headers: JSON_HEADERS,
      });
    } catch (err) {
      const leaked = this.containers.get(sessionId);
      this.containers.delete(sessionId);
      if (leaked) {
        const c = this.docker.getContainer(leaked.containerId);
        await c.kill().catch(() => {});
        await c.remove().catch(() => {});
      }
      return jsonResponse(
        { error: err instanceof Error ? err.message : "Failed to start container" },
        500,
      );
    }
  }

  private async handleTerminate(sessionId: string, path: string): Promise<Response> {
    const entry = this.containers.get(sessionId);
    if (!entry) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    const resp = await fetch(`http://localhost:${entry.port}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
    });

    try {
      const c = this.docker.getContainer(entry.containerId);
      await c.kill().catch(() => {});
      await c.remove().catch(() => {});
    } catch {
      // Container may already be stopped
    }
    this.containers.delete(sessionId);

    return new Response(await resp.text(), {
      status: resp.status,
      headers: JSON_HEADERS,
    });
  }

  private async proxyRequest(sessionId: string, path: string, request: Request): Promise<Response> {
    const entry = this.containers.get(sessionId);
    if (!entry) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    const body = request.method !== "GET" ? await request.text() : undefined;
    const resp = await fetch(`http://localhost:${entry.port}${path}`, {
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
    throw new Error(`SessionHost container not ready after ${timeoutMs}ms`);
  }
}
