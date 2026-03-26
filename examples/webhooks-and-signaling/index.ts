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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { createWebhookReceiver } from "./webhook-receiver.js";
import { runDemo } from "./run-demo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(__dirname, "../../packages/flamecast/src/flamecast/agent.ts");

const PORT = 3002;
const WEBHOOK_PORT = 3004;
const WEBHOOK_SECRET = "demo-secret";

// --- Flamecast server with both tiers wired ---

const flamecast = new Flamecast({
  runtimes: { default: new NodeRuntime() },

  // Tier 2: external webhook — every session delivers events here
  webhooks: [{ url: `http://localhost:${WEBHOOK_PORT}/events`, secret: WEBHOOK_SECRET }],

  agentTemplates: [
    {
      id: "example",
      name: "Example agent",
      spawn: { command: "pnpm", args: ["exec", "tsx", agentPath] },
      runtime: { provider: "default" },
    },
  ],

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

// --- Start ---

const receiver = createWebhookReceiver(WEBHOOK_PORT, WEBHOOK_SECRET);

serve({ fetch: flamecast.app.fetch, port: PORT }, async () => {
  try {
    await runDemo(`http://localhost:${PORT}/api`);
  } catch (err) {
    console.error(`  ✗ Failed: ${err}`);
  }
  receiver.close();
  await flamecast.shutdown();
  process.exit(0);
});
