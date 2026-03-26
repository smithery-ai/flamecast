/* oxlint-disable no-type-assertion/no-type-assertion */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import type { Runtime } from "@flamecast/sdk/runtime";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Session-host binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the session-host static binary on the host filesystem.
 *
 * Lookup order:
 *   1. `SESSION_HOST_BINARY` env var (explicit override)
 *   2. Go binary next to session-host-go package
 *      (`packages/session-host-go/dist/session-host`)
 *
 * The Go binary is statically linked (CGO_ENABLED=0), works on any Linux
 * distro (glibc or musl), and weighs ~6MB.
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

  // 2. Go binary relative to this package (monorepo layout)
  // runtime-docker lives at packages/runtime-docker — go binary is at packages/session-host-go/dist/
  const candidates = [
    join(__dirname, "../../session-host-go/dist/session-host"),
    join(__dirname, "../../../packages/session-host-go/dist/session-host"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    "No session-host binary found. Build it with: " +
      "cd packages/session-host-go && CGO_ENABLED=0 go build -o dist/session-host -ldflags='-s -w' .",
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
    this.baseImage = opts?.baseImage ?? "ubuntu:24.04";
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
      const binaryPath = resolveSessionHostBinary();

      console.log(
        `[DockerRuntime] Starting container (image=${this.baseImage}, binary=${binaryPath})`,
      );

      const container = await this.docker.createContainer({
        Image: this.baseImage,
        Cmd: [CONTAINER_BIN_PATH],
        ExposedPorts: { [`${CONTAINER_PORT}/tcp`]: {} },
        Env: [`SESSION_HOST_PORT=${CONTAINER_PORT}`, "RUNTIME_SETUP_ENABLED=1"],
        HostConfig: {
          Binds: [`${binaryPath}:${CONTAINER_BIN_PATH}:ro`],
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
