/**
 * Example: Webhooks and Signaling
 *
 * Demonstrates both event delivery tiers:
 *
 *   Tier 1 (internal) — in-process handlers fire synchronously.
 *   Tier 2 (external) — events POST'd to an HTTP endpoint with HMAC signatures.
 *
 * Run:
 *   pnpm --filter @flamecast/session-host --filter @flamecast/example-webhooks-and-signaling dev
 */
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { EXAMPLE_TEMPLATE, PORTS, startServer } from "@flamecast/example-shared/create-example.js";
import { createWebhookReceiver } from "./webhook-receiver.js";
import { runDemo } from "./run-demo.js";

const WEBHOOK_SECRET = "demo-secret";

const flamecast = new Flamecast({
  runtimes: { default: new NodeRuntime() },
  agentTemplates: [EXAMPLE_TEMPLATE],

  // Tier 2: external webhook — every session delivers events here
  webhooks: [{ url: `http://localhost:${PORTS.webhook}/events`, secret: WEBHOOK_SECRET }],

  // Tier 1: in-process handlers
  onPermissionRequest: async (c) => {
    console.log(`  [handler]  Permission: "${c.title}" — approved`);
    return c.allow();
  },
  onSessionEnd: async (c) => {
    console.log(`  [handler]  Session ended (${c.reason})`);
  },
  onError: async (c) => {
    console.log(`  [handler]  Error: ${c.error.message}`);
  },
});

const receiver = createWebhookReceiver(PORTS.webhook, WEBHOOK_SECRET);

await startServer(flamecast, async (apiUrl) => {
  try {
    await runDemo(apiUrl);
  } finally {
    receiver.close();
  }
});
