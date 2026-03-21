import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Flamecast } from "./index.js";
import {
  CreateConnectionBodySchema,
  PermissionResponseBodySchema,
  PromptBodySchema,
  RegisterAgentProcessBodySchema,
} from "../shared/connection.js";

export type FlamecastApi = Pick<
  Flamecast,
  | "kill"
  | "create"
  | "get"
  | "list"
  | "listAgentProcesses"
  | "prompt"
  | "registerAgentProcess"
  | "respondToPermission"
>;

function toErrorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}

function toStringMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the Hono API routes for a Flamecast instance.
 * This is infrastructure — decoupled from the orchestration core.
 */
export function createApi(flamecast: FlamecastApi) {
  return new Hono()
    .get("/health", async (c) => {
      try {
        const connections = await flamecast.list();
        return c.json({ status: "ok", connections: connections.length });
      } catch (e) {
        return c.json({ status: "degraded", error: toErrorMessage(e) }, 503);
      }
    })
    .get("/agent-processes", (c) => {
      return c.json(flamecast.listAgentProcesses());
    })
    .post("/agent-processes", zValidator("json", RegisterAgentProcessBodySchema), (c) => {
      const body = c.req.valid("json");
      const row = flamecast.registerAgentProcess(body);
      return c.json(row, 201);
    })
    .get("/connections", async (c) => {
      return c.json(await flamecast.list());
    })
    .post("/connections", zValidator("json", CreateConnectionBodySchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const info = await flamecast.create(body);
        return c.json(info, 201);
      } catch (e) {
        console.error("Connection creation failed:", e);
        return c.json({ error: toStringMessage(e) }, 400);
      }
    })
    .get("/connections/:id", async (c) => {
      try {
        const info = await flamecast.get(c.req.param("id"));
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
        return c.json({ error: toErrorMessage(e) }, 400);
      }
    })
    .post(
      "/connections/:id/permissions/:requestId",
      zValidator("json", PermissionResponseBodySchema),
      async (c) => {
        const body = c.req.valid("json");
        try {
          await flamecast.respondToPermission(c.req.param("id"), c.req.param("requestId"), body);
          return c.json({ ok: true });
        } catch (e) {
          return c.json({ error: toErrorMessage(e) }, 400);
        }
      },
    )
    .delete("/connections/:id", async (c) => {
      try {
        await flamecast.kill(c.req.param("id"));
        return c.json({ ok: true });
      } catch {
        return c.json({ error: "Connection not found" }, 404);
      }
    });
}

export type AppType = ReturnType<typeof createApi>;
