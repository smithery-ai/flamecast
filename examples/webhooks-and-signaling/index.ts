/**
 * Example: Webhooks and Signaling
 *
 * Demonstrates both event delivery tiers in a single run:
 *
 *   Tier 1 (internal signaling) — in-process handlers fire when the
 *   session-host calls back to the control plane. Permission requests
 *   are handled synchronously; session lifecycle events are logged.
 *
 *   Tier 2 (external webhooks) — events are also POST'd to a local
 *   HTTP receiver with HMAC-SHA256 signatures, simulating how a Slack
 *   bot or external system would receive events.
 *
 * Run:
 *   pnpm --filter @flamecast/session-host --filter @flamecast/example-webhooks-and-signaling dev
 */
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { verifyWebhookSignature } from "@flamecast/protocol/verify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(__dirname, "../../packages/flamecast/src/flamecast/agent.ts");

const PORT = 3002;
const WEBHOOK_PORT = 3004;
const WEBHOOK_SECRET = "demo-secret";
const BASE = `http://localhost:${PORT}/api`;

// ---------------------------------------------------------------------------
// Webhook receiver — logs signed events from Tier 2 delivery
// ---------------------------------------------------------------------------

const webhookServer = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();

  const sig = req.headers["x-flamecast-signature"];
  const verified = typeof sig === "string" && verifyWebhookSignature(WEBHOOK_SECRET, body, sig);
  const payload = JSON.parse(body);

  console.log(`  [webhook]  ${payload.event.type} (${verified ? "✓ signed" : "✗ bad sig"})`);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

// ---------------------------------------------------------------------------
// Flamecast server — both tiers wired
// ---------------------------------------------------------------------------

const flamecast = new Flamecast({
  runtimes: { default: new NodeRuntime() },

  // Global webhook — every session delivers events here (Tier 2)
  webhooks: [{ url: `http://localhost:${WEBHOOK_PORT}/events`, secret: WEBHOOK_SECRET }],

  agentTemplates: [
    {
      id: "example",
      name: "Example agent",
      spawn: { command: "pnpm", args: ["exec", "tsx", agentPath] },
      runtime: { provider: "default" },
    },
  ],

  // Tier 1 — in-process handlers
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

// ---------------------------------------------------------------------------
// Start both servers, then run the demo
// ---------------------------------------------------------------------------

webhookServer.listen(WEBHOOK_PORT);

serve({ fetch: flamecast.app.fetch, port: PORT }, async () => {
  console.log();
  console.log("  Webhooks and Signaling");
  console.log("  " + "─".repeat(40));

  const start = Date.now();

  try {
    process.stdout.write("  Creating session...  ");
    const createRes = await fetch(`${BASE}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentTemplateId: "example" }),
    });
    const session = await createRes.json();
    if (!createRes.ok) throw new Error(JSON.stringify(session));
    console.log(`✓ ${session.id}`);

    const prompt = "write hello world to /tmp/test.txt";
    console.log(`  Sending prompt: "${prompt}"`);

    const promptRes = await fetch(`${BASE}/agents/${session.id}/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
    });
    const result = await promptRes.json();
    if (!promptRes.ok) throw new Error(JSON.stringify(result));
    console.log(`  → Agent completed`);

    // Brief pause for webhook deliveries to arrive
    await new Promise((r) => setTimeout(r, 500));

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  Done in ${elapsed}s`);
  } catch (err) {
    console.error(`  ✗ Failed: ${err}`);
  }

  console.log();
  webhookServer.close();
  await flamecast.shutdown();
  process.exit(0);
});
