import dotenv from "dotenv";
dotenv.config();

/**
 * Example: Flamecast Slack Bot
 *
 * Demonstrates webhook-based event delivery to a Slack bot.
 * Mirrors the pattern from examples/webhooks-and-signaling.
 *
 * Run:
 *   pnpm --filter @flamecast/session-host --filter @flamecast/example-slack dev
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { createFlamecastClient } from "@flamecast/sdk/client";
import { EXAMPLE_TEMPLATE, PORTS } from "@flamecast/example-shared/create-example.js";
import { createBot } from "./bot.js";
import { createWebhookHandler } from "./webhooks.js";

const port = PORTS.flamecast;
const botUrl = process.env.BOT_URL || `http://localhost:${port}`;
const webhookSecret = process.env.WEBHOOK_SECRET || "demo-secret";

// ---------------------------------------------------------------------------
// Flamecast instance (in-process, same as webhooks-and-signaling example)
// ---------------------------------------------------------------------------

const flamecast = new Flamecast({
  runtimes: { default: new NodeRuntime() },
  agentTemplates: [EXAMPLE_TEMPLATE],

  // Global webhook — Flamecast delivers ALL session events here.
  webhooks: [{ url: `${botUrl}/flamecast/events`, secret: webhookSecret }],

  // Auto-approve all permissions (same as webhooks-and-signaling example)
  onPermissionRequest: async (c) => {
    console.log(`[flamecast] Permission: "${c.title}" — auto-approved`);
    return c.allow();
  },

  onSessionEnd: async (c) => {
    console.log(`[flamecast] Session ended (${c.reason})`);
  },
});

// ---------------------------------------------------------------------------
// REST client (talks to our own in-process server)
// ---------------------------------------------------------------------------

const apiUrl = `http://localhost:${port}/api`;
const client = createFlamecastClient({ baseUrl: apiUrl });

// ---------------------------------------------------------------------------
// Chat SDK bot + webhook handler
// ---------------------------------------------------------------------------

const bot = createBot(client);
const handleWebhook = createWebhookHandler(webhookSecret);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = new Hono();

// Slack events (mentions, messages, button clicks)
// Read raw text to preserve exact bytes for Slack signature verification.
app.post("/slack/events", async (c) => {
  const rawBody = await c.req.text();
  const parsed = JSON.parse(rawBody);
  if (parsed.type === "url_verification") {
    return c.json({ challenge: parsed.challenge });
  }
  // Re-create request with the original raw body so HMAC signature stays valid
  const raw = new Request(c.req.raw.url, {
    method: "POST",
    headers: c.req.raw.headers,
    body: rawBody,
  });
  return bot.webhooks.slack(raw);
});

// Flamecast webhook events (end_turn, permission_request, error, session_end)
app.post("/flamecast/events", (c) => handleWebhook(c.req.raw));

// Flamecast API (sessions, prompts, permissions) — delegate via fetch to avoid
// Hono version mismatch between the SDK's bundled Hono and our dependency.
app.all("/api/*", (c) => flamecast.app.fetch(c.req.raw));
app.get("/health", (c) => flamecast.app.fetch(c.req.raw));

// Wait for session-host, then start server
async function waitForSessionHost(url = process.env.RUNTIME_URL ?? "http://localhost:8787") {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${url}/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("Session host not ready");
}

await waitForSessionHost();
await new Promise<void>((ready) => {
  serve({ fetch: app.fetch, port }, () => ready());
});

console.log(`Slack bot + Flamecast running on port ${port}`);
console.log(`Slack event URL: ${botUrl}/slack/events`);
console.log(`Flamecast API: ${apiUrl}`);
