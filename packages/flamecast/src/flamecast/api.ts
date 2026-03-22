import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Flamecast } from "./index.js";
import { isFlamecastNotFoundError } from "./errors.js";
import {
  type Agent,
  type CreateAgentBody,
  type CreateSessionBody,
  type FilePreview,
  type FileSystemSnapshot,
  type PermissionResponseBody,
  type RegisterAgentTemplateBody,
  type Session,
  CreateAgentBodySchema,
  CreateSessionBodySchema,
  PermissionResponseBodySchema,
  PromptBodySchema,
  RegisterAgentTemplateBodySchema,
} from "../shared/session.js";

type SessionQueryOptions = {
  includeFileSystem?: boolean;
  showAllFiles?: boolean;
};

export type FlamecastApi = {
  createAgent(body: CreateAgentBody): Promise<Agent>;
  createSession(body: CreateSessionBody): Promise<Session>;
  getAgent(id: string): Promise<Agent>;
  getFilePreview(
    ...args: [id: string, path: string] | [agentId: string, sessionId: string, path: string]
  ): Promise<FilePreview>;
  getSession(
    ...args:
      | [id: string, opts?: SessionQueryOptions]
      | [agentId: string, sessionId: string, opts?: SessionQueryOptions]
  ): Promise<Session>;
  getSessionFileSystem(
    agentId: string,
    sessionId: string,
    opts?: { showAllFiles?: boolean },
  ): Promise<FileSystemSnapshot>;
  handleAcp(agentId: string, request: Request): Promise<Response>;
  listAgents(): Promise<Agent[]>;
  listAgentTemplates: Flamecast["listAgentTemplates"];
  listSessions(): Promise<Session[]>;
  promptSession(id: string, text: string): Promise<{ stopReason: string }>;
  registerAgentTemplate(
    body: RegisterAgentTemplateBody,
  ): ReturnType<Flamecast["registerAgentTemplate"]>;
  respondToPermission(id: string, requestId: string, body: PermissionResponseBody): Promise<void>;
  terminateAgent(id: string): Promise<void>;
  terminateSession(id: string): Promise<void>;
};

function toErrorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}

function toStringMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return isFlamecastNotFoundError(error);
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
      } catch (error) {
        if (isNotFound(error)) {
          return c.json({ error: "Agent not found" }, 404);
        }
        return c.json({ error: toErrorMessage(error) }, 500);
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
      } catch (error) {
        if (isNotFound(error)) {
          return c.json({ error: "Session not found" }, 404);
        }
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .get("/agents/:agentId/sessions/:sessionId/filesystem", async (c) => {
      try {
        const showAllFiles = c.req.query("showAllFiles") === "true";
        const fileSystem = await flamecast.getSessionFileSystem(
          c.req.param("agentId"),
          c.req.param("sessionId"),
          {
            ...(showAllFiles ? { showAllFiles: true } : {}),
          },
        );
        return c.json(fileSystem);
      } catch (error) {
        if (isNotFound(error)) {
          return c.json({ error: "Session not found" }, 404);
        }
        return c.json({ error: toErrorMessage(error) }, 500);
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
      } catch (error) {
        if (isNotFound(error)) {
          return c.json({ error: "Agent not found" }, 404);
        }
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .delete("/agents/:agentId", async (c) => {
      try {
        await flamecast.terminateAgent(c.req.param("agentId"));
        return c.json({ ok: true });
      } catch (error) {
        if (isNotFound(error)) {
          return c.json({ error: "Agent not found" }, 404);
        }
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    });
}

export type AppType = ReturnType<typeof createApi>;
