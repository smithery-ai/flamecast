import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  CreateConnectionBodySchema,
  PermissionResponseBodySchema,
  PromptBodySchema,
  RegisterAgentProcessBodySchema,
} from "../shared/connection.js";
import { flamecast, integrations } from "./runtime.js";

const api = new Hono()
  .get("/agent-processes", (c) => {
    return c.json(flamecast.listAgentProcesses());
  })
  .post("/agent-processes", zValidator("json", RegisterAgentProcessBodySchema), (c) => {
    const body = c.req.valid("json");
    const row = flamecast.registerAgentProcess(body);
    return c.json(row, 201);
  })
  .get("/connections", (c) => {
    return c.json(flamecast.list());
  })
  .post("/connections", zValidator("json", CreateConnectionBodySchema), async (c) => {
    try {
      const body = c.req.valid("json");
      const info = await flamecast.create(body);
      return c.json(info, 201);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      return c.json({ error: message }, 400);
    }
  })
  .get("/connections/:id", (c) => {
    try {
      const info = flamecast.get(c.req.param("id"));
      return c.json(info);
    } catch {
      return c.json({ error: "Connection not found" }, 404);
    }
  })
  .post("/connections/:id/prompt", zValidator("json", PromptBodySchema), async (c) => {
    const { text } = c.req.valid("json");
    try {
      const result = await flamecast.prompt(c.req.param("id"), text);
      return c.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      return c.json({ error: message }, 400);
    }
  })
  .post(
    "/connections/:id/permissions/:requestId",
    zValidator("json", PermissionResponseBodySchema),
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
  })
  .get("/integrations/installs", async (c) => {
    try {
      const installs = await integrations.store.listInstalls();
      return c.json(installs);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: message }, 503);
    }
  });

export default api;
export type AppType = typeof api;
