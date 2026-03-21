import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Flamecast } from "./index.js";
import { CreateAgentBodySchema, RegisterAgentTemplateBodySchema } from "../shared/session.js";

export type FlamecastApi = Pick<
  Flamecast,
  | "createAgent"
  | "getAgent"
  | "getFilePreview"
  | "getSession"
  | "handleAcp"
  | "listAgents"
  | "listSessions"
  | "listAgentTemplates"
  | "registerAgentTemplate"
  | "terminateAgent"
>;

function toErrorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}

function toStringMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createApi(flamecast: FlamecastApi) {
  return new Hono()
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
    .get("/agents", async (c) => {
      return c.json(await flamecast.listAgents());
    })
    .post("/agents", zValidator("json", CreateAgentBodySchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const agent = await flamecast.createAgent(body);
        return c.json(agent, 201);
      } catch (error) {
        console.error("Agent creation failed:", error);
        return c.json({ error: toStringMessage(error) }, 400);
      }
    })
    .get("/agents/:agentId", async (c) => {
      try {
        return c.json(await flamecast.getAgent(c.req.param("agentId")));
      } catch {
        return c.json({ error: "Agent not found" }, 404);
      }
    })
    .get("/agents/:agentId/sessions/:sessionId", async (c) => {
      try {
        const includeFileSystem = c.req.query("includeFileSystem") === "true";
        const showAllFiles = c.req.query("showAllFiles") === "true";
        const session = await flamecast.getSession(
          c.req.param("agentId"),
          c.req.param("sessionId"),
          {
            ...(includeFileSystem ? { includeFileSystem: true } : {}),
            ...(showAllFiles ? { showAllFiles: true } : {}),
          },
        );
        return c.json(session);
      } catch {
        return c.json({ error: "Session not found" }, 404);
      }
    })
    .get("/agents/:agentId/sessions/:sessionId/file", async (c) => {
      const path = c.req.query("path");
      if (!path) {
        return c.json({ error: "Missing path" }, 400);
      }
      try {
        const preview = await flamecast.getFilePreview(
          c.req.param("agentId"),
          c.req.param("sessionId"),
          path,
        );
        return c.json(preview);
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 400);
      }
    })
    .all("/agents/:agentId/acp", async (c) => {
      try {
        return await flamecast.handleAcp(c.req.param("agentId"), c.req.raw);
      } catch {
        return c.json({ error: "Agent not found" }, 404);
      }
    })
    .delete("/agents/:agentId", async (c) => {
      try {
        await flamecast.terminateAgent(c.req.param("agentId"));
        return c.json({ ok: true });
      } catch {
        return c.json({ error: "Agent not found" }, 404);
      }
    });
}

export type AppType = ReturnType<typeof createApi>;
