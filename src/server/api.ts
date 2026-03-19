import { Hono } from "hono";
import { Flamecast } from "../flamecast/index.js";
import type { AgentType } from "../shared/connection.js";

const api = new Hono();
const flamecast = new Flamecast();

// List all active connections
api.get("/connections", (c) => {
  return c.json(flamecast.list());
});

// Create a new connection
api.post("/connections", async (c) => {
  const body = await c.req.json<{ agent?: AgentType; cwd?: string }>();
  const info = await flamecast.create({
    agent: body.agent ?? "example",
    cwd: body.cwd,
  });
  return c.json(info, 201);
});

// Get a specific connection
api.get("/connections/:id", (c) => {
  try {
    const info = flamecast.get(c.req.param("id"));
    return c.json(info);
  } catch {
    return c.json({ error: "Connection not found" }, 404);
  }
});

// Send a prompt to a connection
api.post("/connections/:id/prompt", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  try {
    const result = await flamecast.prompt(c.req.param("id"), text);
    return c.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

// Respond to a pending permission request
api.post("/connections/:id/permissions/:requestId", async (c) => {
  const body = await c.req.json<
    { optionId: string } | { outcome: "cancelled" }
  >();
  try {
    flamecast.respondToPermission(
      c.req.param("id"),
      c.req.param("requestId"),
      body,
    );
    return c.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

// Kill a connection
api.delete("/connections/:id", (c) => {
  try {
    flamecast.kill(c.req.param("id"));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "Connection not found" }, 404);
  }
});

export default api;
