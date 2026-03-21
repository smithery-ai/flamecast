import { Hono } from "hono";
import { createApi, type FlamecastApi } from "../flamecast/api.js";

export function createServerApp(flamecast: FlamecastApi) {
  const app = new Hono();
  app.route("/api", createApi(flamecast));
  return app;
}

export type ServerAppType = ReturnType<typeof createServerApp>;
