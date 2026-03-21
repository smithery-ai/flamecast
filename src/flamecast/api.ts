import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Flamecast } from "./index.js";
import { isFlamecastNotFoundError } from "./errors.js";
import { CreateAgentBodySchema } from "../shared/session.js";

export type FlamecastApi = Pick<
  Flamecast,
  | "createAgent"
  | "getAgent"
  | "getFilePreview"
  | "getSessionFileSystem"
  | "getSession"
  | "handleAcp"
  | "listAgents"
  | "listSessions"
  | "terminateAgent"
>;

function toErrorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}

function toStringMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return isFlamecastNotFoundError(error);
}

const SessionQuerySchema = z.object({
  includeFileSystem: z.literal("true").optional(),
  showAllFiles: z.literal("true").optional(),
});

const FileSystemQuerySchema = z.object({
  showAllFiles: z.literal("true").optional(),
});

const FilePreviewQuerySchema = z.object({
  path: z.string().min(1),
});

export function createApi(flamecast: FlamecastApi) {
  return new Hono()
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
      } catch (error) {
        if (isNotFound(error)) {
          return c.json({ error: "Agent not found" }, 404);
        }
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })
    .get(
      "/agents/:agentId/sessions/:sessionId",
      zValidator("query", SessionQuerySchema),
      async (c) => {
        try {
          const query = c.req.valid("query");
          const includeFileSystem = query.includeFileSystem === "true";
          const showAllFiles = query.showAllFiles === "true";
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
      },
    )
    .get(
      "/agents/:agentId/sessions/:sessionId/filesystem",
      zValidator("query", FileSystemQuerySchema),
      async (c) => {
        try {
          const query = c.req.valid("query");
          const showAllFiles = query.showAllFiles === "true";
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
      },
    )
    .get(
      "/agents/:agentId/sessions/:sessionId/file",
      zValidator("query", FilePreviewQuerySchema, (result, c) => {
        if (!result.success) {
          return c.json({ error: "Missing path" }, 400);
        }
      }),
      async (c) => {
        const { path } = c.req.valid("query");
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
      },
    )
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
