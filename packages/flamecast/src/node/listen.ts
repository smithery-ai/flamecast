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
    flamecast.bridgedSessions.add(payload.sessionId);
    bridge.connect(payload.sessionId, payload.websocketUrl);
  });

  flamecast.eventBus.onSessionTerminated((payload) => {
    flamecast.bridgedSessions.delete(payload.sessionId);
  });

  const adapter = new WsAdapter({
    server,
    eventBus: flamecast.eventBus,
    flamecast,
  });

  // Recover previously-active sessions and re-establish bridge connections.
  // The onRecovered callback runs before the recovery promise resolves, so
  // API calls gated on recovery already see sessions with active bridges.
  void flamecast
    .recoverSessions((recovered) => {
      for (const { sessionId, websocketUrl } of recovered) {
        flamecast.bridgedSessions.add(sessionId);
        bridge.connect(sessionId, websocketUrl);
      }
      if (recovered.length > 0) {
        console.log(`[Flamecast] Recovered ${recovered.length} session(s)`);
      }
    })
    .catch((err) => {
      console.warn(
        "[Flamecast] Session recovery failed:",
        err instanceof Error ? err.message : err,
      );
    });

  return {
    async close() {
      adapter.close();
      bridge.disconnectAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
