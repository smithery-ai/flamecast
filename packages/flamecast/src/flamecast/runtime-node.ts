import type { Runtime } from "@flamecast/protocol/runtime";

// All Node.js-specific imports are dynamic to avoid breaking edge bundles.
// NodeRuntime is re-exported via flamecast/index.ts which is shared between
// the Node entry point (index.ts) and the edge entry point (edge.ts).

/** Minimal subset of ChildProcess we use. */
interface ManagedProcess {
  killed: boolean;
  stdout: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * NodeRuntime — manages a local runtime-host Go binary.
 *
 * By default, resolves and spawns the Go binary from `@flamecast/session-host-go/dist`.
 * Pass a URL explicitly to connect to an already-running runtime-host instead.
 */
export class NodeRuntime implements Runtime {
  readonly onlyOne = true;

  private readonly explicitUrl: string | undefined;
  private process: ManagedProcess | null = null;
  private url: string | null = null;
  private starting: Promise<void> | null = null;

  constructor(url?: string) {
    this.explicitUrl = url;
    if (url) {
      this.url = url;
    }
  }

  private async ensureRunning(): Promise<string> {
    // If an explicit URL was provided, just use it (externally managed)
    if (this.explicitUrl) return this.explicitUrl;

    // Already running
    if (this.url && this.process && !this.process.killed) return this.url;

    // Another call is already starting the process
    if (this.starting) {
      await this.starting;
      if (!this.url) throw new Error("Runtime-host failed to start");
      return this.url;
    }

    this.starting = this.spawnRuntimeHost();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    if (!this.url) throw new Error("Runtime-host failed to start");
    return this.url;
  }

  private async spawnRuntimeHost(): Promise<void> {
    const { resolveNativeBinary } = await import("@flamecast/session-host-go/resolve");
    const { spawn } = await import("node:child_process");

    const binaryPath = resolveNativeBinary();
    if (!binaryPath) {
      throw new Error(
        "No native runtime-host binary found. Run: pnpm --filter @flamecast/session-host-go run postinstall",
      );
    }

    const port = await findFreePort();

    const proc = spawn(binaryPath, [], {
      env: { ...process.env, SESSION_HOST_PORT: String(port) },
      stdio: ["ignore", "pipe", "inherit"],
    });

    this.process = proc;

    // Wait for the "listening on port" message
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error("Runtime-host did not start within 15s"));
      }, 15_000);

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        process.stdout.write(text);
        buffer += text;
        if (buffer.includes("listening on port")) {
          clearTimeout(timeout);
          proc.stdout?.removeListener("data", onData);
          // Pipe remaining output
          proc.stdout?.pipe(process.stdout);
          resolve();
        }
      };

      proc.stdout?.on("data", onData);
      proc.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
      proc.on("exit", (code: number | null) => {
        clearTimeout(timeout);
        this.process = null;
        this.url = null;
        reject(new Error(`Runtime-host exited with code ${code}`));
      });
    });

    this.url = `http://localhost:${port}`;

    // Clean up on unexpected exit
    proc.on("exit", () => {
      if (this.process === proc) {
        this.process = null;
        this.url = null;
      }
    });
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const baseUrl = await this.ensureRunning();
    const originalUrl = new URL(request.url);
    const targetUrl = new URL(baseUrl);
    targetUrl.pathname = `/sessions/${sessionId}${originalUrl.pathname}`;
    targetUrl.search = originalUrl.search;

    const init: RequestInit & { duplex?: string } = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      duplex: request.body ? "half" : undefined,
    };
    const resp = await fetch(targetUrl.toString(), init);

    // For /start responses, inject the runtime-host URLs (shared across all sessions)
    if (originalUrl.pathname.endsWith("/start") && request.method === "POST" && resp.ok) {
      const body = await resp.json();
      const runtimeUrl = new URL(baseUrl);
      body.hostUrl = runtimeUrl.toString().replace(/\/$/, "");
      body.websocketUrl = runtimeUrl.toString().replace(/^http/, "ws").replace(/\/$/, "");
      return new Response(JSON.stringify(body), {
        status: resp.status,
        headers: resp.headers,
      });
    }

    return resp;
  }

  async fetchInstance(_instanceId: string, request: Request): Promise<Response> {
    const baseUrl = await this.ensureRunning();
    const originalUrl = new URL(request.url);
    const targetUrl = new URL(baseUrl);
    targetUrl.pathname = originalUrl.pathname;
    targetUrl.search = originalUrl.search;

    const init: RequestInit & { duplex?: string } = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      duplex: request.body ? "half" : undefined,
    };
    return fetch(targetUrl.toString(), init);
  }

  async dispose(): Promise<void> {
    const proc = this.process;
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      // Give it a moment to shut down gracefully
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 3_000);
        proc.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.process = null;
    this.url = null;
  }
}

function findFreePort(): Promise<number> {
  return import("node:net").then(
    ({ createServer }) =>
      new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, () => {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          server.close(() => resolve(port));
        });
        server.on("error", reject);
      }),
  );
}
