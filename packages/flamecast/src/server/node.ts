/**
 * Node.js server — starts Flamecast with HTTP + WebSocket adapter.
 *
 * This module is only imported via `@flamecast/sdk` (the default Node entry
 * point). Serverless deploys use `@flamecast/sdk/serverless` which never
 * touches this file, keeping `ws` and `@hono/node-server` out of the bundle.
 */
import { serve } from "@hono/node-server";
import type { Flamecast } from "../flamecast/index.js";
import { SessionHostBridge } from "../flamecast/session-host-bridge.js";
import { WsAdapter } from "../flamecast/ws-adapter.js";

/**
 * Start the Flamecast server on the given port.
 * Sets up the HTTP API and the multiplexed WebSocket adapter at `ws://host/ws`.
 *
 * @example
 * ```ts
 * import { Flamecast, listen } from "@flamecast/sdk";
 *
 * const flamecast = new Flamecast({ runtimes: { default: new NodeRuntime() } });
 * await listen(flamecast, 3001);
 * ```
 */
export function listen(flamecast: Flamecast, port: number): void {
  const server = serve({ fetch: flamecast.app.fetch, port });

  const bridge = new SessionHostBridge({ eventBus: flamecast.eventBus });

  flamecast.eventBus.onSessionCreated((payload) => {
    bridge.connect(payload.sessionId, payload.websocketUrl);
  });

  new WsAdapter({
    server,
    eventBus: flamecast.eventBus,
    flamecast,
  });

  flamecast.hasWebSocket = true;
  console.log(`Flamecast running on http://localhost:${port}`);
}
