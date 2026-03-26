import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Flamecast } from "./index.js";
import {
  CreateSessionBodySchema,
  RegisterAgentTemplateBodySchema,
  createRegisterAgentTemplateBodySchema,
} from "../shared/session.js";

export type FlamecastApi = Pick<
  Flamecast,
  | "createSession"
  | "getSession"
  | "handleSessionEvent"
  | "listAgentTemplates"
  | "listSessions"
  | "promptSession"
  | "proxyQueueRequest"
  | "resolvePermission"
  | "registerAgentTemplate"
  | "terminateSession"
  | "runtimeNames"
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
  // Build a runtime-aware schema that validates provider against registered names.
  const [first, ...rest] = flamecast.runtimeNames;
  const registerSchema = first
    ? createRegisterAgentTemplateBodySchema([first, ...rest])
    : RegisterAgentTemplateBodySchema;

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

  return (
    new Hono()
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
      .post("/agent-templates", zValidator("json", registerSchema), async (c) => {
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
          const reqUrl = new URL(c.req.url);
          const callbackUrl = `${reqUrl.protocol}//${reqUrl.host}/api`;
          const session = await flamecast.createSession(body, { callbackUrl });
          return c.json(session, 201);
        } catch (error) {
          console.error("Agent creation failed:", error);
          const status = isClientError(error) ? 400 : 500;
          return c.json({ error: toErrorMessage(error) }, status);
        }
      })
      .get("/agents/:agentId", async (c) => getAgentSnapshot(c, c.req.param("agentId")))
      .get("/agents/:agentId/", async (c) => getAgentSnapshot(c, c.req.param("agentId")))
      .post("/agents/:agentId/prompts", async (c) => {
        try {
          const agentId = c.req.param("agentId");
          const { text } = await c.req.json();
          if (!text || typeof text !== "string") {
            return c.json({ error: "Missing 'text' field" }, 400);
          }
          const result = await flamecast.promptSession(agentId, text);
          return c.json(result);
        } catch (error) {
          console.error("Prompt failed:", error);
          const status = toErrorMessage(error).includes("not found") ? 404 : 500;
          return c.json({ error: toErrorMessage(error) }, status);
        }
      })
      .post("/agents/:agentId/events", async (c) => {
        try {
          const agentId = c.req.param("agentId");
          const event = await c.req.json();
          if (!event || typeof event.type !== "string" || !event.data) {
            return c.json({ error: "Invalid event: missing type or data" }, 400);
          }
          return c.json(await flamecast.handleSessionEvent(agentId, event));
        } catch (error) {
          console.error("Session event callback failed:", error);
          return c.json({ error: toErrorMessage(error) }, 500);
        }
      })
      .post("/agents/:agentId/permissions/:requestId", async (c) => {
        try {
          const agentId = c.req.param("agentId");
          const requestId = c.req.param("requestId");
          const body = await c.req.json();
          if (!body || (!("optionId" in body) && !("outcome" in body))) {
            return c.json({ error: "Missing optionId or outcome field" }, 400);
          }
          const result = await flamecast.resolvePermission(agentId, requestId, body);
          return c.json(result);
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = msg.includes("not found") ? 404 : 500;
          return c.json({ error: msg }, status);
        }
      })
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
      })
      // ---- Queue management (proxy to session-host) ----
      .get("/agents/:agentId/queue", async (c) => {
        return proxyQueue(c, flamecast, "/queue", "GET");
      })
      .delete("/agents/:agentId/queue/:queueId", async (c) => {
        return proxyQueue(c, flamecast, `/queue/${c.req.param("queueId")}`, "DELETE");
      })
      .delete("/agents/:agentId/queue", async (c) => {
        return proxyQueue(c, flamecast, "/queue", "DELETE");
      })
      .put("/agents/:agentId/queue", async (c) => {
        return proxyQueue(c, flamecast, "/queue", "PUT", await c.req.text());
      })
      .post("/agents/:agentId/queue/pause", async (c) => {
        return proxyQueue(c, flamecast, "/queue/pause", "POST");
      })
      .post("/agents/:agentId/queue/resume", async (c) => {
        return proxyQueue(c, flamecast, "/queue/resume", "POST");
      })
  );
}

async function proxyQueue(
  c: Context,
  flamecast: FlamecastApi,
  path: string,
  method: string,
  body?: string,
): Promise<Response> {
  try {
    const agentId = c.req.param("agentId") ?? "";
    const resp = await flamecast.proxyQueueRequest(agentId, path, {
      method,
      ...(body ? { body } : {}),
    });
    const data = await resp.json().catch(() => null);
    // oxlint-disable-next-line no-type-assertion/no-type-assertion -- Hono's StatusCode requires a literal; resp.status is dynamic
    return c.json(data ?? { error: "Invalid response from session-host" }, resp.status as 200);
  } catch (error) {
    const msg = toErrorMessage(error);
    const status = msg.includes("not found") ? 404 : 500;
    return c.json({ error: msg }, status);
  }
}

export type AppType = ReturnType<typeof createApi>;
