import { Hono } from "hono";
import { createApi, type FlamecastApi } from "./api.js";

export function createServerApp(flamecast: FlamecastApi) {
  const app = new Hono();
  app.route("/api", createApi(flamecast));
  return app;
}
