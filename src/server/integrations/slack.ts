import { Hono } from "hono";
import type { ChatGateway } from "./chat-gateway.js";

export function createSlackRoutes(chatGateway: ChatGateway): Hono {
  return new Hono()
    .get("/integrations/slack/install", async (c) => chatGateway.startSlackInstall(c.req.raw))
    .get("/integrations/slack/oauth/callback", async (c) =>
      chatGateway.handleSlackCallback(c.req.raw),
    )
    .post("/integrations/slack/events", async (c) => chatGateway.handleSlackWebhook(c.req.raw));
}
