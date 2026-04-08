import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import type { Flamecast } from "./index.js";
import {
  CreateSessionBodySchema,
  RegisterAgentTemplateBodySchema,
  UpdateAgentTemplateBodySchema,
  createRegisterAgentTemplateBodySchema,
} from "../shared/session.js";
import type { Session } from "../shared/session.js";
import type { RuntimeInfo, RuntimeInstance } from "@flamecast/protocol/runtime";
import { toWsChannelEvent } from "./events/channels.js";

export type FlamecastApi = Pick<
  Flamecast,
  | "createSession"
  | "eventBus"
  | "fetchRuntimeFilePreview"
  | "fetchRuntimeFileSystem"
  | "fetchRuntimeGit"
  | "fetchSessionFilePreview"
  | "fetchSessionFileSystem"
  | "getSession"
  | "handleSessionEvent"
  | "listAgentTemplates"
  | "listRuntimes"
  | "listSessions"
  | "pauseRuntime"
  | "promptSession"
  | "proxyQueueRequest"
  | "resolvePermission"
  | "registerAgentTemplate"
  | "updateAgentTemplate"
  | "startRuntime"
  | "stopRuntime"
  | "deleteRuntime"
  | "terminateSession"
  | "runtimeNames"
>;

function toErrorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}

type ApiErrorStatus = 400 | 403 | 404 | 409 | 500;

function toErrorStatus(error: unknown): ApiErrorStatus | null {
  if (typeof error === "object" && error && "status" in error && typeof error.status === "number") {
    if (
      error.status === 400 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 409 ||
      error.status === 500
    ) {
      return error.status;
    }
  }
  return null;
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

  const rewriteWebsocketUrl = (requestUrl: string, websocketUrl?: string): string | undefined => {
    if (!websocketUrl) return undefined;

    const candidate = new URL(websocketUrl);
    if (
      candidate.hostname !== "localhost" &&
      candidate.hostname !== "127.0.0.1" &&
      candidate.hostname !== "[::1]"
    ) {
      return websocketUrl;
    }

    const request = new URL(requestUrl);
    candidate.hostname = request.hostname;
    candidate.port = request.port;
    // Non-localhost hosts are behind TLS (e.g. Cloudflare tunnel), so always use wss.
    // Localhost may be plain HTTP, so check the request protocol.
    const isSecure =
      request.protocol === "https:" ||
      (request.hostname !== "localhost" &&
        request.hostname !== "127.0.0.1" &&
        request.hostname !== "[::1]");
    candidate.protocol = isSecure ? "wss:" : "ws:";
    return candidate.toString();
  };

  const toClientSession = (requestUrl: string, session: Session): Session => {
    const websocketUrl = rewriteWebsocketUrl(requestUrl, session.websocketUrl);
    if (!websocketUrl || websocketUrl === session.websocketUrl) {
      return session;
    }

    return { ...session, websocketUrl };
  };

  const toClientRuntimeInstance = (
    requestUrl: string,
    instance: RuntimeInstance,
  ): RuntimeInstance => {
    const websocketUrl = rewriteWebsocketUrl(requestUrl, instance.websocketUrl);
    if (!websocketUrl || websocketUrl === instance.websocketUrl) {
      return instance;
    }

    return { ...instance, websocketUrl };
  };

  const toClientRuntimeInfo = (requestUrl: string, runtimeInfo: RuntimeInfo): RuntimeInfo => ({
    ...runtimeInfo,
    instances: runtimeInfo.instances.map((instance) =>
      toClientRuntimeInstance(requestUrl, instance),
    ),
  });

  // The agent routes are public API sugar over the current single-session runtime model.
  const getAgentSnapshot = async (c: Context, agentId: string) => {
    try {
      const includeFileSystem = c.req.query("includeFileSystem") === "true";
      const showAllFiles = c.req.query("showAllFiles") === "true";
      const session = await flamecast.getSession(agentId, {
        ...(includeFileSystem ? { includeFileSystem: true } : {}),
        ...(showAllFiles ? { showAllFiles: true } : {}),
      });
      return c.json(toClientSession(c.req.url, session));
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
      .put("/agent-templates/:id", zValidator("json", UpdateAgentTemplateBodySchema), async (c) => {
        try {
          const id = c.req.param("id");
          const body = c.req.valid("json");
          const template = await flamecast.updateAgentTemplate(id, body);
          return c.json(template);
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = msg.includes("not found") ? 404 : 500;
          return c.json({ error: msg }, status);
        }
      })
      // ---- Runtime lifecycle ----
      .get("/runtimes", async (c) => {
        try {
          const runtimes = await flamecast.listRuntimes();
          return c.json(runtimes.map((runtime) => toClientRuntimeInfo(c.req.url, runtime)));
        } catch (error) {
          console.error("List runtimes failed:", error);
          return c.json({ error: toErrorMessage(error) }, 500);
        }
      })
      .post("/runtimes/:typeName/start", async (c) => {
        try {
          const typeName = c.req.param("typeName");
          const body = await c.req.json().catch(() => ({}));
          const name = body && typeof body === "object" && "name" in body ? body.name : undefined;
          const instance = await flamecast.startRuntime(typeName, name);
          return c.json(toClientRuntimeInstance(c.req.url, instance), 201);
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = isClientError(error) ? 400 : 500;
          return c.json({ error: msg }, status);
        }
      })
      .post("/runtimes/:instanceName/stop", async (c) => {
        try {
          const instanceName = c.req.param("instanceName");
          await flamecast.stopRuntime(instanceName);
          return c.json({ ok: true });
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = msg.includes("not found") ? 404 : 500;
          return c.json({ error: msg }, status);
        }
      })
      .delete("/runtimes/:instanceName", async (c) => {
        try {
          const instanceName = c.req.param("instanceName");
          await flamecast.deleteRuntime(instanceName);
          return c.json({ ok: true });
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = msg.includes("not found") ? 404 : 500;
          return c.json({ error: msg }, status);
        }
      })
      .post("/runtimes/:instanceName/pause", async (c) => {
        try {
          const instanceName = c.req.param("instanceName");
          await flamecast.pauseRuntime(instanceName);
          return c.json({ ok: true });
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = msg.includes("not found") ? 404 : 500;
          return c.json({ error: msg }, status);
        }
      })
      .get("/runtimes/:instanceName/files", async (c) => {
        try {
          const instanceName = c.req.param("instanceName");
          const path = c.req.query("path");
          if (!path) {
            return c.json({ error: "Missing ?path= parameter" }, 400);
          }
          return c.json(await flamecast.fetchRuntimeFilePreview(instanceName, path));
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = toErrorStatus(error) ?? (msg.includes("not found") ? 404 : 500);
          return c.json({ error: msg }, status);
        }
      })
      .get("/runtimes/:instanceName/fs/snapshot", async (c) => {
        try {
          const instanceName = c.req.param("instanceName");
          const showAllFiles = c.req.query("showAllFiles") === "true";
          const path = c.req.query("path") || undefined;
          return c.json(
            await flamecast.fetchRuntimeFileSystem(instanceName, { showAllFiles, path }),
          );
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = toErrorStatus(error) ?? (msg.includes("not found") ? 404 : 500);
          return c.json({ error: msg }, status);
        }
      })
      // ---- Git operations ----
      .get("/runtimes/:instanceName/fs/git/branches", async (c) => {
        try {
          const instanceName = c.req.param("instanceName");
          const params = new URLSearchParams();
          const path = c.req.query("path");
          if (path) params.set("path", path);
          const query = params.size > 0 ? `?${params.toString()}` : "";
          return c.json(await flamecast.fetchRuntimeGit(instanceName, `branches${query}`));
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = toErrorStatus(error) ?? (msg.includes("not found") ? 404 : 500);
          return c.json({ error: msg }, status);
        }
      })
      .get("/runtimes/:instanceName/fs/git/commits", async (c) => {
        try {
          const instanceName = c.req.param("instanceName");
          const params = new URLSearchParams();
          const path = c.req.query("path");
          if (path) params.set("path", path);
          const branch = c.req.query("branch");
          if (branch) params.set("branch", branch);
          const limit = c.req.query("limit");
          if (limit) params.set("limit", limit);
          const query = params.size > 0 ? `?${params.toString()}` : "";
          return c.json(await flamecast.fetchRuntimeGit(instanceName, `commits${query}`));
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = toErrorStatus(error) ?? (msg.includes("not found") ? 404 : 500);
          return c.json({ error: msg }, status);
        }
      })
      .get("/runtimes/:instanceName/fs/git/worktrees", async (c) => {
        try {
          const instanceName = c.req.param("instanceName");
          const params = new URLSearchParams();
          const path = c.req.query("path");
          if (path) params.set("path", path);
          const query = params.size > 0 ? `?${params.toString()}` : "";
          return c.json(await flamecast.fetchRuntimeGit(instanceName, `worktrees${query}`));
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = toErrorStatus(error) ?? (msg.includes("not found") ? 404 : 500);
          return c.json({ error: msg }, status);
        }
      })
      .post("/runtimes/:instanceName/fs/git/worktrees", async (c) => {
        try {
          const instanceName = c.req.param("instanceName");
          const body = await c.req.text();
          return c.json(
            await flamecast.fetchRuntimeGit(instanceName, "worktrees", {
              method: "POST",
              body,
            }),
            201,
          );
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = toErrorStatus(error) ?? (isClientError(error) ? 400 : 500);
          return c.json({ error: msg }, status);
        }
      })
      .get("/agents", async (c) => {
        try {
          const sessions = await flamecast.listSessions();
          return c.json(sessions.map((session) => toClientSession(c.req.url, session)));
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
          return c.json(toClientSession(c.req.url, session), 201);
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
      .get("/agents/:agentId/files", async (c) => {
        try {
          const agentId = c.req.param("agentId");
          const path = c.req.query("path");
          if (!path) {
            return c.json({ error: "Missing ?path= parameter" }, 400);
          }
          return c.json(await flamecast.fetchSessionFilePreview(agentId, path));
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = toErrorStatus(error) ?? (msg.includes("not found") ? 404 : 500);
          return c.json({ error: msg }, status);
        }
      })
      .get("/agents/:agentId/fs/snapshot", async (c) => {
        try {
          const showAllFiles = c.req.query("showAllFiles") === "true";
          const path = c.req.query("path") || undefined;
          return c.json(
            await flamecast.fetchSessionFileSystem(c.req.param("agentId"), { showAllFiles, path }),
          );
        } catch (error) {
          const msg = toErrorMessage(error);
          const status = toErrorStatus(error) ?? (msg.includes("not found") ? 404 : 500);
          return c.json({ error: msg }, status);
        }
      })
      // ---- SSE event stream (universal — works in Node + edge) ----
      .get("/agents/:agentId/stream", (c) => {
        const agentId = c.req.param("agentId");
        const lastEventId = c.req.header("Last-Event-ID");
        const since = lastEventId ? parseInt(lastEventId, 10) : undefined;

        return streamSSE(c, async (stream) => {
          // Replay history (mirrors WS adapter's handleSubscribe behavior)
          const history = flamecast.eventBus.getHistory(agentId, {
            since: Number.isFinite(since) ? since : undefined,
          });
          for (const event of history) {
            const msg = toWsChannelEvent(event, `session:${event.sessionId}`);
            stream.writeSSE({
              data: JSON.stringify(msg),
              event: event.event.type,
              id: String(event.seq),
            });
          }

          // Live events
          const unsub = flamecast.eventBus.onEvent((event) => {
            if (event.agentId !== agentId) return;
            const msg = toWsChannelEvent(event, `session:${event.sessionId}`);
            stream.writeSSE({
              data: JSON.stringify(msg),
              event: event.event.type,
              id: String(event.seq),
            });
          });

          const unsubCreated = flamecast.eventBus.onSessionCreated((payload) => {
            if (payload.agentId !== agentId) return;
            stream.writeSSE({
              data: JSON.stringify({ type: "session.created", ...payload }),
              event: "session.created",
            });
          });

          const unsubTerminated = flamecast.eventBus.onSessionTerminated((payload) => {
            if (payload.agentId !== agentId) return;
            stream.writeSSE({
              data: JSON.stringify({ type: "session.terminated", ...payload }),
              event: "session.terminated",
            });
            stream.close();
          });

          // Single onAbort — cleanup + resolve the keep-alive promise
          await new Promise<void>((resolve) => {
            stream.onAbort(() => {
              unsub();
              unsubCreated();
              unsubTerminated();
              resolve();
            });
          });
        });
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
