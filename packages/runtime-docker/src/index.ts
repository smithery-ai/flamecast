import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import type { Runtime } from "@flamecast/sdk/runtime";

/** Resolve the @flamecast/session-host package directory (contains dist/ + package.json). */
function resolveSessionHostDir(): string {
  const resolved = import.meta.resolve("@flamecast/session-host");
  // resolved points to the package's main entry (dist/index.js) — go up to the package root.
  return dirname(dirname(fileURLToPath(resolved)));
}

/**
 * Copy session-host's dist/ and package.json into a build context subdirectory.
 * This avoids bind-mounting pnpm's symlinked node_modules into the container.
 */
async function copySessionHostToBuildContext(tmpDir: string): Promise<void> {
  const shDir = resolveSessionHostDir();
  const dest = join(tmpDir, "session-host");
  await mkdir(dest, { recursive: true });
  await cp(join(shDir, "dist"), join(dest, "dist"), { recursive: true });
  await cp(join(shDir, "package.json"), join(dest, "package.json"));
}

const CONTAINER_PORT = "8080";
const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * DockerRuntime — spawns a new container per session.
 *
 * The container is built from `baseImage` + the optional `setup` script
 * provided in the start request. Session-host is baked into the image
 * (copied from the @flamecast/session-host package) and used as the entrypoint.
 */
export class DockerRuntime implements Runtime {
  private readonly baseImage: string;
  private readonly docker: Docker;
  private readonly containers = new Map<string, { containerId: string; port: number }>();
  /** Cache of images already built in this runtime's lifetime (keyed by content hash). */
  private readonly builtImages = new Map<string, string>();

  constructor(opts?: {
    baseImage?: string;
    docker?: Docker;
  }) {
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
      const image = await this.resolveImage(setup);
      console.log(`[DockerRuntime] Creating container from image: ${image}`);

      const container = await this.docker.createContainer({
        Image: image,
        ExposedPorts: { [`${CONTAINER_PORT}/tcp`]: {} },
        HostConfig: {
          PortBindings: { [`${CONTAINER_PORT}/tcp`]: [{ HostPort: "0" }] },
          AutoRemove: true,
        },
        Env: ["RUNTIME_SETUP_ENABLED=1"],
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

      // Override workspace to the container's agent workspace — host path doesn't exist inside.
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
   * Build (or reuse) a Docker image from `baseImage` + optional `setup` script.
   * Images are cached by a content hash of the generated Dockerfile.
   */
  private async resolveImage(setup?: string): Promise<string> {
    const dockerfileLines = [
      `FROM ${this.baseImage}`,
      `RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates git && rm -rf /var/lib/apt/lists/*`,
      // Bake session-host into the image
      `COPY session-host/ /session-host/`,
      `RUN cd /session-host && npm install --omit=dev`,
      // Agent workspace
      `WORKDIR /workspace`,
    ];

    if (setup) {
      dockerfileLines.push(`COPY setup.sh /tmp/setup.sh`);
      dockerfileLines.push(`RUN sh /tmp/setup.sh && rm /tmp/setup.sh`);
    }

    // Entrypoint + port
    dockerfileLines.push(`ENV SESSION_HOST_PORT=${CONTAINER_PORT}`);
    dockerfileLines.push(`EXPOSE ${CONTAINER_PORT}`);
    dockerfileLines.push(`CMD ["node", "/session-host/dist/index.js"]`);

    const dockerfileContent = dockerfileLines.join("\n") + "\n";
    // Hash includes setup content so different scripts produce different images
    const hashInput = dockerfileContent + (setup ?? "");
    const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 12);
    const tag = `flamecast-session-${hash}:latest`;

    // Return cached image if it still exists
    const cached = this.builtImages.get(hash);
    if (cached) {
      try {
        await this.docker.getImage(cached).inspect();
        return cached;
      } catch {
        this.builtImages.delete(hash);
      }
    }

    console.log(`[DockerRuntime] Building image ${tag}`);

    const tmpDir = await mkdtemp(join(tmpdir(), "flamecast-build-"));
    try {
      await writeFile(join(tmpDir, "Dockerfile"), dockerfileContent);
      await copySessionHostToBuildContext(tmpDir);
      if (setup) {
        await writeFile(join(tmpDir, "setup.sh"), setup);
      }

      const buildStream = await this.docker.buildImage(
        { context: tmpDir, src: ["."] },
        { t: tag, dockerfile: "Dockerfile" },
      );

      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(
          buildStream,
          (err: Error | null) => (err ? reject(err) : resolve()),
          (event: { stream?: string; error?: string }) => {
            if (event.error) {
              process.stderr.write(`[DockerRuntime] ${event.error}\n`);
            } else if (event.stream) {
              process.stdout.write(event.stream);
            }
          },
        );
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    // Verify the image was actually created
    try {
      await this.docker.getImage(tag).inspect();
    } catch {
      throw new Error(`Docker build completed but image "${tag}" was not created`);
    }

    this.builtImages.set(hash, tag);
    return tag;
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
