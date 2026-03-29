import { Hono } from "hono";
import { cors } from "hono/cors";
import { createApi, type FlamecastApi } from "./api.js";
import type { FlamecastAuth } from "./index.js";

export function createServerApp(flamecast: FlamecastApi, auth?: FlamecastAuth) {
  const app = new Hono();
  app.use("*", cors());
  if (auth) {
    app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  }
  app.route("/api", createApi(flamecast));
  return app;
}
