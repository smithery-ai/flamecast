import { Hono } from "hono";
import { hc } from "hono/client";
import type { Flamecast } from "../../src/flamecast/index.js";
import { createApi, type AppType } from "../../src/flamecast/api.js";

// ---------------------------------------------------------------------------
// Hono test client
// ---------------------------------------------------------------------------

/**
 * Build a typed hc client from a Flamecast instance (no real HTTP server needed).
 */
export function createClient(flamecast: Flamecast) {
  const api = createApi(flamecast);
  const app = new Hono().route("/api", api);
  return hc<AppType>("http://localhost/api", {
    fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
      return app.fetch(new Request(String(input), init));
    },
  });
}
