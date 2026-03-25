import { dirname, basename } from "node:path";
import Docker from "dockerode";
import type { Runtime } from "@flamecast/sdk/runtime";

const CONTAINER_PORT = "8080";

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
      if (this.containers.has(sessionId)) {
        return new Response(JSON.stringify({ error: "Session already exists" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
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
          Env: [
            `SESSION_HOST_PORT=${CONTAINER_PORT}`,
            // Enable setup script execution inside the container
            "RUNTIME_SETUP_ENABLED=1",
          ],
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

        // Override workspace to the container's WORKDIR — the host path doesn't
        // exist inside the container and causes exec/spawn ENOENT.
        parsed.workspace = "/app";

        // Forward the /start request to the session-host inside the container
        const containerBody = JSON.stringify(parsed);
        const resp = await fetch(`http://localhost:${port}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: containerBody,
        });

        const result = await resp.json();
        // Override URLs to point to the host-mapped port
        result.hostUrl = `http://localhost:${port}`;
        result.websocketUrl = `ws://localhost:${port}`;

        return new Response(JSON.stringify(result), {
          status: resp.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        // Clean up the container if it was started but /start failed
        const leaked = this.containers.get(sessionId);
        this.containers.delete(sessionId);
        if (leaked) {
          const c = this.docker.getContainer(leaked.containerId);
          await c.kill().catch(() => {});
        }
        return new Response(
          JSON.stringify({
            error: err instanceof Error ? err.message : "Failed to start container",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const entry = this.containers.get(sessionId);
    if (!entry) {
      return new Response(JSON.stringify({ error: `Session ${sessionId} not found` }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = request.method !== "GET" ? await request.text() : undefined;
    const resp = await fetch(`http://localhost:${entry.port}${path}`, {
      method: request.method,
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (path.endsWith("/terminate") && request.method === "POST") {
      try {
        const c = this.docker.getContainer(entry.containerId);
        await c.kill();
      } catch {
        // Container may already be stopped (AutoRemove)
      }
      this.containers.delete(sessionId);
    }

    return new Response(await resp.text(), {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async dispose(): Promise<void> {
    for (const [, entry] of this.containers) {
      try {
        const c = this.docker.getContainer(entry.containerId);
        await c.kill();
      } catch {
        // Best-effort
      }
    }
    this.containers.clear();
  }

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
      // Check if the image exists locally
      try {
        await this.docker.getImage(image).inspect();
        return image;
      } catch {
        // Image doesn't exist locally — if we also have a dockerfile, build it
        if (dockerfile) {
          return this.buildImage(dockerfile, image);
        }
        throw new Error(
          `Docker image "${image}" not found locally. Build it first or provide a dockerfile.`,
        );
      }
    }

    if (dockerfile) {
      const tag = `flamecast-session-${Date.now()}`;
      return this.buildImage(dockerfile, tag);
    }

    return this.fallbackImage;
  }

  /**
   * Build a Docker image from a Dockerfile path. Caches by dockerfile path
   * so repeated session starts don't rebuild.
   */
  private async buildImage(dockerfilePath: string, tag: string): Promise<string> {
    const cached = this.builtImages.get(dockerfilePath);
    if (cached) return cached;

    const context = dirname(dockerfilePath);
    const dockerfileName = basename(dockerfilePath);

    console.log(`[DockerRuntime] Building image ${tag} from ${dockerfilePath}`);

    const stream = await this.docker.buildImage(
      { context, src: [dockerfileName] },
      { t: tag, dockerfile: dockerfileName },
    );

    // Wait for build to complete
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => (err ? reject(err) : resolve()),
        (event: { stream?: string }) => {
          if (event.stream) process.stdout.write(event.stream);
        },
      );
    });

    this.builtImages.set(dockerfilePath, tag);
    return tag;
  }

  private async waitForReady(port: number, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    // Poll HTTP health endpoint — Docker's port-forwarding proxy accepts TCP
    // connections before the app inside is listening, so TCP checks alone
    // are unreliable. Just retry the HTTP health check.
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
