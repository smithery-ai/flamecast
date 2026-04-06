import { Hono } from "hono";
import { cors } from "hono/cors";
import { createApi, type FlamecastApi } from "./api.js";

export function createServerApp(flamecast: FlamecastApi) {
  const app = new Hono();
  app.use("/api/*", cors());
  app.route("/api", createApi(flamecast));
  return app;
}
