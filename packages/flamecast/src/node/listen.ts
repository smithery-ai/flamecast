/**
 * Node.js server — starts Flamecast with the HTTP API.
 *
 * This module is only imported via `@flamecast/sdk` (the default Node entry
 * point). Edge deploys use `@flamecast/sdk/edge` which never touches this
 * file, keeping `@hono/node-server` out of the bundle.
 */
import { serve as honoServe } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Flamecast } from "../flamecast/index.js";

/**
 * Start the Flamecast server with the HTTP API.
 * Returns a handle for graceful shutdown.
 *
 * @example
 * ```ts
 * import { Flamecast, listen } from "@flamecast/sdk";
 *
 * const flamecast = new Flamecast({ runtimes: { default: new NodeRuntime() } });
 * const handle = listen(flamecast, { port: 3001 }, (info) => {
 *   console.log(`Flamecast running on http://localhost:${info.port}`);
 * });
 *
 * // Graceful shutdown
 * await handle.close();
 * ```
 */
export function listen(
  flamecast: Flamecast,
  options: { port: number },
  listeningListener?: (info: AddressInfo) => void,
): { close(): Promise<void> } {
  const server = honoServe({ fetch: flamecast.app.fetch, port: options.port }, listeningListener);

  // Recover previously-active sessions so the HTTP control plane can resume
  // proxying requests after a server restart. Runtime WebSockets are direct,
  // so there is no in-process bridge to re-establish here.
  void flamecast.recoverSessions().catch((err) => {
    console.warn("[Flamecast] Session recovery failed:", err instanceof Error ? err.message : err);
  });

  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
