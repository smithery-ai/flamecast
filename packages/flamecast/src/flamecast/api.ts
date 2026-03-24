import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Flamecast } from "./index.js";
import {
  AgentSnapshotQuerySchema,
  CreateSessionBodySchema,
  PromptBodySchema,
  RegisterAgentTemplateBodySchema,
} from "../shared/session.js";

export type FlamecastApi = Pick<
  Flamecast,
  | "createSession"
  | "getSession"
  | "listAgentTemplates"
  | "listSessions"
  | "promptSession"
  | "registerAgentTemplate"
  | "terminateSession"
>;

function toErrorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}

function toStringMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createApi(flamecast: FlamecastApi) {
  const getAgentSnapshot = async (c: Context, agentId: string) => {
    try {
      const includeFileSystem = c.req.query("includeFileSystem") === "true";
      const showAllFiles = c.req.query("showAllFiles") === "true";
      const session = await flamecast.getSession(agentId, {
        ...(includeFileSystem ? { includeFileSystem: true } : {}),
        ...(showAllFiles ? { showAllFiles: true } : {}),
      });
      return c.json(session);
    } catch {
      return c.json({ error: "Agent not found" }, 404);
    }
  };

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
    .get("/agents", async (c) => {
      return c.json(await flamecast.listSessions());
    })
    .post("/agents", zValidator("json", CreateSessionBodySchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const session = await flamecast.createSession(body);
        return c.json(session, 201);
      } catch (error) {
        console.error("Agent creation failed:", error);
        return c.json({ error: toStringMessage(error) }, 400);
      }
    })
    .get("/agents/:agentId", zValidator("query", AgentSnapshotQuerySchema), async (c) =>
      getAgentSnapshot(c, c.req.param("agentId")),
    )
    .get("/agents/:agentId/", zValidator("query", AgentSnapshotQuerySchema), async (c) =>
      getAgentSnapshot(c, c.req.param("agentId")),
    )
    .post("/agents/:agentId/prompt", zValidator("json", PromptBodySchema), async (c) => {
      const { text } = c.req.valid("json");
      try {
        const result = await flamecast.promptSession(c.req.param("agentId"), text);
        if ("queued" in result && result.queued) {
          return c.json(result, 202);
        }
        return c.json(result);
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 400);
      }
    })
    .delete("/agents/:agentId", async (c) => {
      try {
        await flamecast.terminateSession(c.req.param("agentId"));
        return c.json({ ok: true });
      } catch {
        return c.json({ error: "Agent not found" }, 404);
      }
    });
}

export type AppType = ReturnType<typeof createApi>;
