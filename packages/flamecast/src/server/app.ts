import { Hono } from "hono";
import { cors } from "hono/cors";
import { createApi, type FlamecastApi } from "../flamecast/api.js";

export function createServerApp(flamecast: FlamecastApi) {
  const app = new Hono();
  app.use("*", cors());
  app.route("/api", createApi(flamecast));
  return app;
}

export type ServerAppType = ReturnType<typeof createServerApp>;
