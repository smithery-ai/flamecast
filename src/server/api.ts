import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Flamecast } from "../flamecast/index.js";
import { agentTypes } from "../shared/connection.js";

const flamecast = new Flamecast();

const api = new Hono()
  .get("/connections", (c) => {
    return c.json(flamecast.list());
  })
  .post(
    "/connections",
    zValidator(
      "json",
      z.object({ agent: z.enum(agentTypes).optional(), cwd: z.string().optional() }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      const info = await flamecast.create({
        agent: body.agent ?? "example",
        cwd: body.cwd,
      });
      return c.json(info, 201);
    },
  )
  .get("/connections/:id", (c) => {
    try {
      const info = flamecast.get(c.req.param("id"));
      return c.json(info);
    } catch {
      return c.json({ error: "Connection not found" }, 404);
    }
  })
  .post(
    "/connections/:id/prompt",
    zValidator("json", z.object({ text: z.string() })),
    async (c) => {
      const { text } = c.req.valid("json");
      try {
        const result = await flamecast.prompt(c.req.param("id"), text);
        return c.json(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        return c.json({ error: message }, 400);
      }
    },
  )
  .post(
    "/connections/:id/permissions/:requestId",
    zValidator(
      "json",
      z.union([z.object({ optionId: z.string() }), z.object({ outcome: z.literal("cancelled") })]),
    ),
    async (c) => {
      const body = c.req.valid("json");
      try {
        flamecast.respondToPermission(c.req.param("id"), c.req.param("requestId"), body);
        return c.json({ ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        return c.json({ error: message }, 400);
      }
    },
  )
  .delete("/connections/:id", (c) => {
    try {
      flamecast.kill(c.req.param("id"));
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Connection not found" }, 404);
    }
  });

export default api;
export type AppType = typeof api;
