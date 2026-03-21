import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Flamecast } from "./index.js";
import {
  CreateSessionBodySchema,
  PermissionResponseBodySchema,
  PromptBodySchema,
  RegisterAgentTemplateBodySchema,
} from "../shared/session.js";

export type FlamecastApi = Pick<
  Flamecast,
  | "createSession"
  | "getFilePreview"
  | "getSession"
  | "listAgentTemplates"
  | "listSessions"
  | "promptSession"
  | "registerAgentTemplate"
  | "respondToPermission"
  | "terminateSession"
>;

function toErrorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}

function toStringMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createApi(flamecast: FlamecastApi) {
  return new Hono()
    .get("/health", async (c) => {
      try {
        const sessions = await flamecast.listSessions();
        return c.json({ status: "ok", sessions: sessions.length });
      } catch (error) {
        return c.json({ status: "degraded", error: toErrorMessage(error) }, 503);
      }
    })
    .get("/agent-templates", async (c) => {
      return c.json(await flamecast.listAgentTemplates());
    })
    .post("/agent-templates", zValidator("json", RegisterAgentTemplateBodySchema), async (c) => {
      const body = c.req.valid("json");
      const template = await flamecast.registerAgentTemplate(body);
      return c.json(template, 201);
    })
    .get("/sessions", async (c) => {
      return c.json(await flamecast.listSessions());
    })
    .post("/sessions", zValidator("json", CreateSessionBodySchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const session = await flamecast.createSession(body);
        return c.json(session, 201);
      } catch (error) {
        console.error("Session creation failed:", error);
        return c.json({ error: toStringMessage(error) }, 400);
      }
    })
    .get("/sessions/:id", async (c) => {
      try {
        const includeFileSystem = c.req.query("includeFileSystem") === "true";
        const showAllFiles = c.req.query("showAllFiles") === "true";
        const session = await flamecast.getSession(c.req.param("id"), {
          ...(includeFileSystem ? { includeFileSystem: true } : {}),
          ...(showAllFiles ? { showAllFiles: true } : {}),
        });
        return c.json(session);
      } catch {
        return c.json({ error: "Session not found" }, 404);
      }
    })
    .get("/sessions/:id/file", async (c) => {
      const path = c.req.query("path");
      if (!path) {
        return c.json({ error: "Missing path" }, 400);
      }
      try {
        const preview = await flamecast.getFilePreview(c.req.param("id"), path);
        return c.json(preview);
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 400);
      }
    })
    .post("/sessions/:id/prompt", zValidator("json", PromptBodySchema), async (c) => {
      const { text } = c.req.valid("json");
      try {
        const result = await flamecast.promptSession(c.req.param("id"), text);
        return c.json(result);
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 400);
      }
    })
    .post(
      "/sessions/:id/permissions/:requestId",
      zValidator("json", PermissionResponseBodySchema),
      async (c) => {
        const body = c.req.valid("json");
        try {
          await flamecast.respondToPermission(c.req.param("id"), c.req.param("requestId"), body);
          return c.json({ ok: true });
        } catch (error) {
          return c.json({ error: toErrorMessage(error) }, 400);
        }
      },
    )
    .delete("/sessions/:id", async (c) => {
      try {
        await flamecast.terminateSession(c.req.param("id"));
        return c.json({ ok: true });
      } catch {
        return c.json({ error: "Session not found" }, 404);
      }
    });
}

export type AppType = ReturnType<typeof createApi>;
