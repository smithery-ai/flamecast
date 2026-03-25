/* oxlint-disable no-type-assertion/no-type-assertion */
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import type { Runtime } from "@flamecast/sdk/runtime";

// ---------------------------------------------------------------------------
// Session-host binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the session-host static binary on the host filesystem.
 *
 * Lookup order:
 *   1. `SESSION_HOST_BINARY` env var (explicit override)
 *   2. Pre-built SEA binary next to the session-host package
 *      (`@flamecast/session-host/dist/session-host-linux-x64`)
 *   3. The self-contained esbuild bundle
 *      (`@flamecast/session-host/dist/session-host.bundle.cjs`)
 *
 * Returns `{ path, needsNode }` — `needsNode` is true when the resolved
 * artifact is a JS bundle (not a compiled binary) and requires `node` inside
 * the container to execute.
 */
function resolveSessionHostArtifact(): { path: string; needsNode: boolean } {
  // 1. Explicit env var
  if (process.env.SESSION_HOST_BINARY) {
    const p = process.env.SESSION_HOST_BINARY;
    if (!existsSync(p)) {
      throw new Error(`SESSION_HOST_BINARY points to "${p}" which does not exist`);
    }
    // Heuristic: .cjs/.mjs/.js files need node; everything else is a binary
    return { path: p, needsNode: /\.(c|m)?js$/u.test(p) };
  }

  // Resolve the @flamecast/session-host package root
  const resolved = import.meta.resolve("@flamecast/session-host");
  const pkgDir = dirname(dirname(fileURLToPath(resolved)));
  const distDir = join(pkgDir, "dist");

  // 2. Pre-built SEA binary (e.g. session-host-linux-x64)
  const arch = process.arch; // x64, arm64
  const binaryPath = join(distDir, `session-host-linux-${arch}`);
  if (existsSync(binaryPath)) {
    return { path: binaryPath, needsNode: false };
  }

  // 3. Self-contained esbuild bundle (fallback — requires node in the container)
  const bundlePath = join(distDir, "session-host.bundle.cjs");
  if (existsSync(bundlePath)) {
    return { path: bundlePath, needsNode: true };
  }

  throw new Error(
    "No session-host artifact found. Run `pnpm --filter @flamecast/session-host build:binary` " +
      "or `pnpm --filter @flamecast/session-host build:bundle` first.",
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTAINER_PORT = "8080";
const CONTAINER_BIN_PATH = "/usr/local/bin/session-host";
const CONTAINER_BUNDLE_PATH = "/usr/local/lib/session-host.bundle.cjs";
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
 * Instead of generating a Dockerfile and building a custom image, this runtime
 * bind-mounts the session-host static binary (or JS bundle) into any
 * user-provided base image. This avoids:
 *
 *   - Dockerfile generation overhead
 *   - CMD/entrypoint conflicts with user images
 *   - Requiring Node.js in the base image (when using the SEA binary)
 *
 * The user's optional `setup` script runs inside the container before the
 * agent is spawned, allowing full control over the environment.
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

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.containers.values()].map(async (entry) => {
        const c = this.docker.getContainer(entry.containerId);
        await c.kill();
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
      const setup = parsed.setup as string | undefined;
      const artifact = resolveSessionHostArtifact();

      console.log(
        `[DockerRuntime] Starting container (image=${this.baseImage}, ` +
          `binary=${artifact.path}, needsNode=${artifact.needsNode})`,
      );

      // Bind-mount the session-host artifact into the container as read-only.
      const containerArtifactPath = artifact.needsNode ? CONTAINER_BUNDLE_PATH : CONTAINER_BIN_PATH;
      const cmd = artifact.needsNode ? ["node", CONTAINER_BUNDLE_PATH] : [CONTAINER_BIN_PATH];

      const container = await this.docker.createContainer({
        Image: this.baseImage,
        Cmd: cmd,
        ExposedPorts: { [`${CONTAINER_PORT}/tcp`]: {} },
        Env: [`SESSION_HOST_PORT=${CONTAINER_PORT}`, "RUNTIME_SETUP_ENABLED=1"],
        HostConfig: {
          Binds: [`${artifact.path}:${containerArtifactPath}:ro`],
          PortBindings: { [`${CONTAINER_PORT}/tcp`]: [{ HostPort: "0" }] },
          AutoRemove: true,
        },
        WorkingDir: "/workspace",
      });

      await container.start();

      const info = await container.inspect();
      const portBindings = info.NetworkSettings.Ports[`${CONTAINER_PORT}/tcp`];
      const port = parseInt(portBindings?.[0]?.HostPort ?? "0", 10);

      if (!port) {
        await container.kill().catch(() => {});
        throw new Error("Failed to get container port");
      }

      this.containers.set(sessionId, { containerId: container.id, port });
      await this.waitForReady(port);

      // Override workspace to the container's agent workspace.
      parsed.workspace = "/workspace";
      if (setup) {
        parsed.setup = setup;
      }

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
      await c.kill();
    } catch {
      // Container may already be stopped (AutoRemove)
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
