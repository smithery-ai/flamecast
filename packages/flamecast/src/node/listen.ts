/**
 * Node.js server — starts Flamecast with the HTTP API.
 *
 * This module is only imported via `@flamecast/sdk` (the default Node entry
 * point). Edge deploys use `@flamecast/sdk/edge` which never touches this
 * file, keeping `@hono/node-server` out of the bundle.
 */
import { serve as honoServe } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AddressInfo } from "node:net";
import { createConnection } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Flamecast } from "../flamecast/index.js";

export type ListenOptions = {
  port: number;
  /**
   * Enable CORS for the API. Pass `true` to allow all origins, or a
   * `cors()` options object to restrict origins, methods, headers, etc.
   *
   * @example
   * // Allow all origins (development)
   * listen(flamecast, { port: 3001, cors: true })
   *
   * @example
   * // Restrict to a specific origin (production)
   * listen(flamecast, { port: 3001, cors: { origin: "https://app.example.com" } })
   */
  cors?: boolean | Parameters<typeof cors>[0];
};

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
  options: ListenOptions,
  listeningListener?: (info: AddressInfo) => void,
): { close(): Promise<void> } {
  let fetchFn = flamecast.app.fetch;

  if (options.cors) {
    const corsOptions = typeof options.cors === "boolean" ? undefined : options.cors;
    const wrapper = new Hono();
    wrapper.use("*", cors(corsOptions));
    wrapper.all("*", (c) => flamecast.app.fetch(c.req.raw));
    fetchFn = wrapper.fetch;
  }

  const server = honoServe({ fetch: fetchFn, port: options.port }, listeningListener);

  // Proxy WebSocket upgrades to the session-host so clients can connect
  // through the API server rather than directly to the runtime port.
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const wsUrl = flamecast.getWebsocketTarget();
    if (!wsUrl) {
      socket.destroy();
      return;
    }

    const target = new URL(wsUrl);
    const upstream = createConnection({ host: target.hostname, port: Number(target.port) }, () => {
      const path = req.url ?? "/";
      const headers = [`GET ${path} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        if (key.toLowerCase() === "host") {
          headers.push(`Host: ${target.host}`);
        } else {
          headers.push(`${key}: ${req.rawHeaders[i + 1]}`);
        }
      }
      upstream.write(headers.join("\r\n") + "\r\n\r\n");
      if (head.length > 0) upstream.write(head);

      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  // Auto-start the first available runtime so it is ready before the first session.
  void flamecast.autoStart().catch(() => {
    // All runtimes rejected — no auto-startable runtime registered. This is
    // expected when only Docker/E2B runtimes are configured.
  });

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
