/**
 * Shared config and helpers for Flamecast examples.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import type { Flamecast, AgentTemplate } from "@flamecast/sdk";

/** Path to the built-in example agent (used by all examples). */
export const AGENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/flamecast/src/flamecast/agent.ts",
);

/** Default agent template wired to the example agent. */
export const EXAMPLE_TEMPLATE: AgentTemplate = {
  id: "example",
  name: "Example agent",
  spawn: { command: "pnpm", args: ["exec", "tsx", AGENT_PATH] },
  runtime: { provider: "default" },
};

/** Default ports for examples. */
export const PORTS = {
  flamecast: 3002,
  webhook: 3004,
} as const;

/**
 * Start a Flamecast instance on an HTTP server, run a callback, then shut down.
 *
 * Handles server lifecycle so examples only provide the Flamecast instance and
 * the demo logic.
 */
export async function startServer(
  flamecast: Flamecast,
  run: (apiUrl: string) => Promise<void>,
  port = PORTS.flamecast,
): Promise<void> {
  let server: ServerType | undefined;
  try {
    await new Promise<void>((ready) => {
      server = serve({ fetch: flamecast.app.fetch, port }, () => ready());
    });
    await run(`http://localhost:${port}/api`);
  } finally {
    server?.close();
    await flamecast.shutdown();
  }
}
