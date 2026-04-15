import { Hono } from "hono";

export function createServerApp() {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  return app;
}
