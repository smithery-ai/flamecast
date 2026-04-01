/**
 * Node.js server — starts Flamecast with the HTTP API.
 */
import { serve as honoServe } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Flamecast } from "../flamecast/index.js";

export function listen(
  flamecast: Flamecast,
  options: { port: number },
  listeningListener?: (info: AddressInfo) => void,
): { close(): Promise<void> } {
  const server = honoServe({ fetch: flamecast.app.fetch, port: options.port }, listeningListener);

  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
