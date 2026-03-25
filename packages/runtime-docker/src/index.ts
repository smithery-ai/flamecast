import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import Docker from "dockerode";
import type { Runtime } from "@flamecast/sdk/runtime";

const execFileAsync = promisify(execFile);

const CONTAINER_PORT = "8080";
const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * DockerRuntime — spawns a new SessionHost container per session.
 *
 * Each session gets its own container on a random host port.
 * The container image is determined (in priority order):
 *   1. `image` field from the agent template's runtime config (in the /start body)
 *   2. `dockerfile` field → built on-the-fly with `docker build`
 *   3. The fallback image passed to the constructor (default: "flamecast-session-host")
 */
export class DockerRuntime implements Runtime {
  private readonly fallbackImage: string;
  private readonly docker: Docker;
  private readonly containers = new Map<string, { containerId: string; port: number }>();
  /** Cache of images already built from dockerfiles in this runtime's lifetime. */
  private readonly builtImages = new Map<string, string>();

  constructor(opts?: { image?: string; docker?: Docker }) {
    this.fallbackImage = opts?.image ?? "flamecast-session-host";
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
      const body = await request.text();
      // oxlint-disable-next-line no-type-assertion/no-type-assertion
      const parsed = JSON.parse(body) as Record<string, unknown>;

      const image = await this.resolveImage(parsed);
      console.log(`[DockerRuntime] Creating container from image: ${image}`);

      const container = await this.docker.createContainer({
        Image: image,
        ExposedPorts: { [`${CONTAINER_PORT}/tcp`]: {} },
        HostConfig: {
          PortBindings: { [`${CONTAINER_PORT}/tcp`]: [{ HostPort: "0" }] },
          AutoRemove: true,
        },
        Env: [`SESSION_HOST_PORT=${CONTAINER_PORT}`, "RUNTIME_SETUP_ENABLED=1"],
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

      // Override workspace to container's WORKDIR — host path doesn't exist inside.
      parsed.workspace = "/app";

      const resp = await fetch(`http://localhost:${port}/start`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(parsed),
      });

      const result = await resp.json();
      result.hostUrl = `http://localhost:${port}`;
      result.websocketUrl = `ws://localhost:${port}`;

      return new Response(JSON.stringify(result), {
        status: resp.status,
        headers: JSON_HEADERS,
      });
    } catch (err) {
      // Clean up the container if it was started but /start failed
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
  // Image resolution
  // ---------------------------------------------------------------------------

  /**
   * Determine which Docker image to use for the container.
   *
   * Priority:
   *   1. Explicit `image` in the request body (template runtime config)
   *   2. Build from `dockerfile` path in the request body
   *   3. Fall back to the constructor-provided image
   */
  private async resolveImage(body: Record<string, unknown>): Promise<string> {
    // oxlint-disable-next-line no-type-assertion/no-type-assertion
    const image = body.image as string | undefined;
    // oxlint-disable-next-line no-type-assertion/no-type-assertion
    const dockerfile = body.dockerfile as string | undefined;

    if (image) {
      try {
        await this.docker.getImage(image).inspect();
        return image;
      } catch {
        if (dockerfile) return this.buildImage(dockerfile, image);
        throw new Error(
          `Docker image "${image}" not found locally. Build it first or provide a dockerfile.`,
        );
      }
    }

    if (dockerfile) {
      const tag = await this.dockerfileTag(dockerfile);
      return this.buildImage(dockerfile, tag);
    }

    return this.fallbackImage;
  }

  /** Deterministic tag from dockerfile content hash (avoids stale image accumulation). */
  private async dockerfileTag(dockerfilePath: string): Promise<string> {
    try {
      const content = await readFile(dockerfilePath, "utf8");
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
      return `flamecast-session-${hash}`;
    } catch {
      return `flamecast-session-fallback`;
    }
  }

  /**
   * Build a Docker image from a Dockerfile path. Caches by dockerfile path
   * so repeated session starts don't rebuild.
   */
  private async buildImage(dockerfilePath: string, tag: string): Promise<string> {
    const fullTag = tag.includes(":") ? tag : `${tag}:latest`;

    const cached = this.builtImages.get(dockerfilePath);
    if (cached === fullTag) {
      try {
        await this.docker.getImage(cached).inspect();
        return cached;
      } catch {
        this.builtImages.delete(dockerfilePath);
      }
    }

    const context = dirname(dockerfilePath);
    console.log(`[DockerRuntime] Building image ${fullTag} from ${dockerfilePath}`);

    await execFileAsync("docker", ["build", "-t", fullTag, "-f", dockerfilePath, context]);

    this.builtImages.set(dockerfilePath, fullTag);
    return fullTag;
  }

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
