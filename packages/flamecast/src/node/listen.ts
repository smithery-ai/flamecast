/**
 * Node.js server — starts Flamecast with HTTP + WebSocket adapter.
 *
 * This module is only imported via `@flamecast/sdk` (the default Node entry
 * point). Edge deploys use `@flamecast/sdk/edge` which never touches this
 * file, keeping `ws` and `@hono/node-server` out of the bundle.
 */
import { serve as honoServe } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Flamecast } from "../flamecast/index.js";
import { SessionHostBridge } from "./session-host-bridge.js";
import { WsAdapter } from "./ws-adapter.js";

/**
 * Start the Flamecast server with HTTP API + WebSocket adapter.
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

  const bridge = new SessionHostBridge({ eventBus: flamecast.eventBus });

  flamecast.eventBus.onSessionCreated((payload) => {
    bridge.connect(payload.sessionId, payload.websocketUrl);
  });

  const adapter = new WsAdapter({
    server,
    eventBus: flamecast.eventBus,
    flamecast,
  });

  return {
    async close() {
      adapter.close();
      bridge.disconnectAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
