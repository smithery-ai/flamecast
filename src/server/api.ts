import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { Flamecast } from "../flamecast/index.js";
import {
  CreateConnectionBodySchema,
  PermissionResponseBodySchema,
  PromptBodySchema,
  RegisterAgentProcessBodySchema,
} from "../shared/connection.js";
import { SlackBindConnectionBodySchema } from "../shared/integrations.js";
import type { SlackInstaller } from "./integrations/slack.js";

export function createApi(flamecast: Flamecast, slackInstaller: SlackInstaller) {
  return new Hono()
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
        const message = e instanceof Error ? e.message : "Unknown error";
        return c.json({ error: message }, 400);
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
          await flamecast.respondToPermission(c.req.param("id"), c.req.param("requestId"), body);
          return c.json({ ok: true });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Unknown error";
          return c.json({ error: message }, 400);
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
    })
    .get("/integrations/slack/installations", async (c) => {
      return c.json(await slackInstaller.listInstallations());
    })
    .get("/connections/:id/integrations/slack", async (c) => {
      const connectionId = c.req.param("id");
      try {
        await flamecast.get(connectionId);
      } catch {
        return c.json({ error: "Connection not found" }, 404);
      }

      try {
        return c.json(await slackInstaller.getConnectionStatus(connectionId));
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        return c.json({ error: message }, 400);
      }
    })
    .post(
      "/connections/:id/integrations/slack/bind",
      zValidator("json", SlackBindConnectionBodySchema),
      async (c) => {
        const connectionId = c.req.param("id");
        const { teamId } = c.req.valid("json");
        try {
          await flamecast.get(connectionId);
        } catch {
          return c.json({ error: "Connection not found" }, 404);
        }

        try {
          return c.json(await slackInstaller.bindConnection(connectionId, teamId));
        } catch (e) {
          const message = e instanceof Error ? e.message : "Unknown error";
          return c.json({ error: message }, 400);
        }
      },
    )
    .delete("/connections/:id/integrations/slack", async (c) => {
      const connectionId = c.req.param("id");
      try {
        await flamecast.get(connectionId);
      } catch {
        return c.json({ error: "Connection not found" }, 404);
      }

      try {
        await slackInstaller.disconnect(connectionId);
        return c.json({ ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        return c.json({ error: message }, 400);
      }
    });
}

export type AppType = ReturnType<typeof createApi>;
