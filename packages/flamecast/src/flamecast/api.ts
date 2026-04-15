import { Hono } from "hono";

export function createApi() {
  return new Hono().get("/health", (c) => c.json({ status: "ok" }));
}
