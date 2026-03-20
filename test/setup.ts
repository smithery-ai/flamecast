import type { TestProject } from "vitest/node";

/**
 * Global setup for integration tests.
 *
 * 1. Runs alchemy.run.ts to deploy the Docker resource graph (network, image, container).
 * 2. Starts the Flamecast API server.
 * 3. Provides the API base URL to all tests.
 * 4. Tears down on cleanup: server stops, alchemy destroys resources.
 */
export async function setup({ provide }: TestProject) {
  // Deploy alchemy infrastructure
  await import("../alchemy.run.ts");

  // Wait for the container's ACP TCP port to be ready
  const ACP_PORT = 9100;
  await waitForPort("localhost", ACP_PORT, 15_000);

  // Start the API server on a random port
  const { serve } = await import("@hono/node-server");
  const { Hono } = await import("hono");
  const { default: api } = await import("../src/server/api.ts");

  const app = new Hono();
  app.route("/api", api);

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, (info) => {
      provide("apiBaseUrl", `http://localhost:${info.port}/api`);
      resolve(s);
    });
  });

  // Return teardown function
  return async () => {
    server.close();
  };
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const { createConnection } = await import("node:net");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Port ${port} not ready after ${timeoutMs}ms`);
}

declare module "vitest" {
  export interface ProvidedContext {
    apiBaseUrl: string;
  }
}
