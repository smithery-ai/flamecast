import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Http2Server } from "node:http2";
import { homedir, platform, arch } from "node:os";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createRestateEndpoint } from "./endpoint.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoStartResult {
  ingressUrl: string;
  adminUrl: string;
  stop: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the platform-specific Restate binary path.
 *
 * The `@restatedev/restate-server` package delegates to a platform-specific
 * package named `@restatedev/restate-server-<platform>-<arch>`. We replicate
 * its `getExePath()` logic here so we can spawn the binary directly rather
 * than going through the wrapper script.
 *
 * The user must install `@restatedev/restate-server` as a dependency when
 * they opt into the Restate runtime — it is intentionally NOT listed in this
 * package's dependencies.
 */
function resolveRestateBinary(): string {
  const require = createRequire(import.meta.url);

  // Map Node.js os values to Restate package naming conventions
  const platformMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };
  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "aarch64",
  };

  const op = platformMap[platform()];
  const ar = archMap[arch()];
  if (!op || !ar) {
    throw new Error(
      `Unsupported platform: ${platform()}-${arch()}. ` +
        `Restate supports linux/darwin on x64/arm64.`,
    );
  }

  try {
    return require.resolve(
      `@restatedev/restate-server-${op}-${ar}/bin/restate-server`,
    );
  } catch {
    throw new Error(
      `Could not find the Restate server binary. ` +
        `Install it with: pnpm add @restatedev/restate-server`,
    );
  }
}

// ---------------------------------------------------------------------------
// Port parsing
// ---------------------------------------------------------------------------

/**
 * Parse Restate's startup output to discover the randomly assigned ports.
 *
 * When started with `--use-random-ports=true`, Restate prints the chosen
 * ports in the first lines of standard output. We look for URL patterns
 * containing host:port in the output stream.
 */
function parseUrls(output: string): { ingress?: string; admin?: string } {
  const result: { ingress?: string; admin?: string } = {};

  // Look for ingress URL (port 8080 by default, random when using random ports)
  const ingressMatch = output.match(
    /(?:ingress|Ingress)[^\n]*?(https?:\/\/[^\s,]+)/i,
  );
  if (ingressMatch) {
    result.ingress = ingressMatch[1];
  }

  // Look for admin URL (port 9071 by default)
  const adminMatch = output.match(
    /(?:admin|Admin)[^\n]*?(https?:\/\/[^\s,]+)/i,
  );
  if (adminMatch) {
    result.admin = adminMatch[1];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Deployment registration
// ---------------------------------------------------------------------------

/**
 * Register a service endpoint with Restate via the admin API.
 *
 * POST /deployments { uri: "<endpoint>" }
 * Retries a few times since Restate may not be fully ready immediately after
 * the ports are printed.
 */
async function registerDeployment(
  adminUrl: string,
  endpointUrl: string,
): Promise<void> {
  const maxRetries = 10;
  const retryDelay = 500; // ms

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(`${adminUrl}/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: endpointUrl }),
      });
      if (resp.ok) return;

      const body = await resp.text();
      if (attempt === maxRetries) {
        throw new Error(
          `Failed to register deployment (HTTP ${resp.status}): ${body}`,
        );
      }
    } catch (err) {
      if (attempt === maxRetries) throw err;
    }
    await new Promise((r) => setTimeout(r, retryDelay));
  }
}

// ---------------------------------------------------------------------------
// Auto-start
// ---------------------------------------------------------------------------

/**
 * Start a local Restate server instance, register Flamecast services on it,
 * and return the ingress URL for `RestateSessionService` to connect to.
 *
 * This is intended for local development — it spawns `restate-server` as a
 * managed child process with random ports and persistent state.
 *
 * Usage:
 * ```ts
 * const restate = await autoStartRestate();
 * const sessions = new RestateSessionService(runtimes, restate.ingressUrl);
 * // ... on shutdown:
 * await restate.stop();
 * ```
 */
export async function autoStartRestate(): Promise<AutoStartResult> {
  // 1. Resolve the binary
  const binaryPath = resolveRestateBinary();

  // 2. Ensure the data directory exists
  const dataDir = path.join(homedir(), ".flamecast", "restate-data");
  await mkdir(dataDir, { recursive: true });

  // 3. Spawn restate-server with random ports
  const child: ChildProcess = spawn(
    binaryPath,
    ["--use-random-ports=true", "--data-dir", dataDir],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // 4. Collect output and parse URLs
  const urls = await new Promise<{ ingress: string; admin: string }>(
    (resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(
            new Error(
              `Restate failed to start within 30s.\nstdout: ${stdout}\nstderr: ${stderr}`,
            ),
          );
        }
      }, 30_000);

      const tryResolve = () => {
        if (resolved) return;
        const fromStdout = parseUrls(stdout);
        const fromStderr = parseUrls(stderr);
        const ingress = fromStdout.ingress ?? fromStderr.ingress;
        const admin = fromStdout.admin ?? fromStderr.admin;
        if (ingress && admin) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ ingress, admin });
        }
      };

      child.stdout!.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        tryResolve();
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        // Prefix and forward Restate's stderr for debugging
        for (const line of text.split("\n")) {
          if (line.trim()) {
            console.error(`[restate] ${line}`);
          }
        }
        tryResolve();
      });

      child.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(
            new Error(`Failed to start Restate: ${err.message}`),
          );
        }
      });

      child.on("exit", (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(
            new Error(
              `Restate exited prematurely with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`,
            ),
          );
        }
      });
    },
  );

  // 5. Start the Flamecast Restate endpoint on a random port.
  //    We use http2Handler() + our own HTTP2 server so we retain a handle
  //    for clean shutdown (listen() returns only a Promise<number>).
  const endpoint = createRestateEndpoint();
  const handler = endpoint.http2Handler();
  const http2Server: Http2Server = createServer(handler);

  const endpointPort = await new Promise<number>((resolve, reject) => {
    http2Server.listen(0, () => {
      const addr = http2Server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to bind Restate endpoint to a random port"));
      }
    });
    http2Server.on("error", reject);
  });
  const endpointUrl = `http://localhost:${endpointPort}`;

  // 6. Register the endpoint with Restate
  await registerDeployment(urls.admin, endpointUrl);

  // 7. Return the result with a stop function
  return {
    ingressUrl: urls.ingress,
    adminUrl: urls.admin,
    stop: async () => {
      // Close the Flamecast service endpoint
      await new Promise<void>((resolve, reject) => {
        http2Server.close((err?: Error) => (err ? reject(err) : resolve()));
      });

      // Gracefully terminate Restate
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const forceKillTimeout = setTimeout(() => {
            child.kill("SIGKILL");
          }, 5_000);
          child.on("exit", () => {
            clearTimeout(forceKillTimeout);
            resolve();
          });
        });
      }
    },
  };
}
