import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Flamecast } from "./index.js";
import { CreateSessionBodySchema, RegisterAgentTemplateBodySchema } from "../shared/session.js";

export type FlamecastApi = Pick<
  Flamecast,
  | "createSession"
  | "getSession"
  | "listAgentTemplates"
  | "listSessions"
  | "registerAgentTemplate"
  | "terminateSession"
>;

function toErrorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}

/** Return true for errors that indicate a client-side problem (bad input). */
function isClientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("unknown agent template") ||
    msg.includes("unknown runtime") ||
    msg.includes("provide agenttemplat") ||
    msg.includes("not found")
  );
}

export function createApi(flamecast: FlamecastApi) {
  // The agent routes are public API sugar over the current single-session runtime model.
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
      try {
        return c.json(await flamecast.listAgentTemplates());
      } catch (error) {
        console.error("List agent templates failed:", error);
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .post("/agent-templates", zValidator("json", RegisterAgentTemplateBodySchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const template = await flamecast.registerAgentTemplate(body);
        return c.json(template, 201);
      } catch (error) {
        console.error("Register agent template failed:", error);
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .get("/agents", async (c) => {
      try {
        return c.json(await flamecast.listSessions());
      } catch (error) {
        console.error("List agents failed:", error);
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .post("/agents", zValidator("json", CreateSessionBodySchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const session = await flamecast.createSession(body);
        return c.json(session, 201);
      } catch (error) {
        console.error("Agent creation failed:", error);
        const status = isClientError(error) ? 400 : 500;
        return c.json({ error: toErrorMessage(error) }, status);
      }
    })
    .get("/agents/:agentId", async (c) => getAgentSnapshot(c, c.req.param("agentId")))
    .get("/agents/:agentId/", async (c) => getAgentSnapshot(c, c.req.param("agentId")))
    .delete("/agents/:agentId", async (c) => {
      try {
        await flamecast.terminateSession(c.req.param("agentId"));
        return c.json({ ok: true });
      } catch (error) {
        const msg = toErrorMessage(error);
        const isNotFound = msg.toLowerCase().includes("not found");
        const isAlreadyKilled = msg.toLowerCase().includes("already-killed");
        if (isNotFound || isAlreadyKilled) {
          return c.json({ error: msg }, isNotFound ? 404 : 409);
        }
        console.error("Agent termination failed:", error);
        return c.json({ error: msg }, 500);
      }
    });
}

export type AppType = ReturnType<typeof createApi>;
