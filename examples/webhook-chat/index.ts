/**
 * Example: Webhook Chat Bot
 *
 * Demonstrates the full external webhook flow — simulating a Slack-like bot
 * that receives agent events via signed webhooks and responds to permission
 * requests via the REST API.
 *
 * Architecture:
 *   ┌──────────────┐  webhooks   ┌──────────────┐  REST   ┌──────────────┐
 *   │  Flamecast   │────────────>│   Chat Bot   │────────>│  Flamecast   │
 *   │  (port 3003) │            │  (port 3004) │         │  /permissions│
 *   └──────────────┘            └──────────────┘         └──────────────┘
 *
 * Run:
 *   pnpm --filter @flamecast/session-host --filter @flamecast/example-webhook-chat dev
 *
 * The example:
 *   1. Starts a Flamecast server on :3003
 *   2. Starts a "chat bot" webhook receiver on :3004
 *   3. Creates a session with webhooks pointing at the bot
 *   4. Sends a prompt via REST
 *   5. Bot receives events, prints chat-style output, auto-approves permissions
 */
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { verifyWebhookSignature } from "@flamecast/protocol/verify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(__dirname, "../../packages/flamecast/src/flamecast/agent.ts");

const FLAMECAST_PORT = 3003;
const BOT_PORT = 3004;
const WEBHOOK_SECRET = "demo-webhook-secret";
const FLAMECAST_URL = `http://localhost:${FLAMECAST_PORT}/api`;
const BOT_URL = `http://localhost:${BOT_PORT}/events`;

// ---------------------------------------------------------------------------
// 1. Chat bot — receives webhook events, prints chat, handles permissions
// ---------------------------------------------------------------------------

function printChat(role: string, text: string): void {
  const prefix = role === "bot" ? "🤖" : role === "system" ? "⚙️ " : "👤";
  const label = role.toUpperCase().padEnd(7);
  console.log(`  ${prefix} ${label} ${text}`);
}

const botServer = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }

  // Read body
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();

  // Verify signature
  const signature = req.headers["x-flamecast-signature"];
  if (typeof signature !== "string" || !verifyWebhookSignature(WEBHOOK_SECRET, body, signature)) {
    printChat("system", "❌ Invalid webhook signature — rejected");
    res.writeHead(401);
    res.end("invalid signature");
    return;
  }

  const payload = JSON.parse(body);
  const { event, sessionId } = payload;

  switch (event.type) {
    case "end_turn": {
      const response = event.data.promptResponse;
      printChat("bot", `Agent finished turn (stopReason: ${response?.stopReason ?? "unknown"})`);
      break;
    }

    case "permission_request": {
      const { requestId, title, options } = event.data;
      const optionNames = options.map((o: { name: string }) => o.name).join(" / ");
      printChat("system", `Permission requested: "${title}" [${optionNames}]`);

      // Auto-approve by calling the REST permission endpoint
      const approveOption = options.find((o: { kind: string }) => o.kind.startsWith("allow"));
      if (approveOption) {
        printChat("bot", `Auto-approving: ${approveOption.name}`);
        const resp = await fetch(`${FLAMECAST_URL}/agents/${sessionId}/permissions/${requestId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ optionId: approveOption.optionId }),
        });
        if (!resp.ok) {
          printChat("system", `⚠️  Permission resolve failed: ${resp.status}`);
        }
      }
      break;
    }

    case "session_end": {
      printChat("system", `Session ended (exit code: ${event.data.exitCode})`);
      break;
    }

    case "error": {
      printChat("system", `Error: ${event.data.message}`);
      break;
    }

    default:
      printChat("system", `Unknown event: ${event.type}`);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

// ---------------------------------------------------------------------------
// 2. Flamecast server — permissions deferred to webhook flow
// ---------------------------------------------------------------------------

const flamecast = new Flamecast({
  runtimes: {
    default: new NodeRuntime(),
  },
  agentTemplates: [
    {
      id: "example",
      name: "Example agent",
      spawn: { command: "pnpm", args: ["exec", "tsx", agentPath] },
      runtime: { provider: "default" },
    },
  ],

  // Defer permissions to the webhook bot — return undefined so the
  // session-host falls back to the WS promise, which the bot resolves
  // via POST /permissions/:requestId
  onPermissionRequest: async () => undefined,
});

// ---------------------------------------------------------------------------
// 3. Start both servers, then run the demo flow
// ---------------------------------------------------------------------------

botServer.listen(BOT_PORT, () => {
  console.log(`\n  Chat bot listening on http://localhost:${BOT_PORT}`);
});

serve({ fetch: flamecast.app.fetch, port: FLAMECAST_PORT }, async () => {
  console.log(`  Flamecast listening on http://localhost:${FLAMECAST_PORT}\n`);
  console.log("─".repeat(60));
  console.log("  WEBHOOK CHAT DEMO");
  console.log("─".repeat(60));

  try {
    // Create session with webhook pointing at the bot
    printChat("system", "Creating session with webhook...");

    const createRes = await fetch(`${FLAMECAST_URL}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentTemplateId: "example",
        webhooks: [
          {
            url: BOT_URL,
            secret: WEBHOOK_SECRET,
          },
        ],
      }),
    });
    const session = await createRes.json();

    if (!createRes.ok) {
      printChat("system", `Failed to create session: ${JSON.stringify(session)}`);
      return;
    }

    printChat("system", `Session ${session.id} created`);
    console.log();

    // Send a prompt
    const prompt = "write a file to disk";
    printChat("user", prompt);

    const promptRes = await fetch(`${FLAMECAST_URL}/agents/${session.id}/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
    });
    const result = await promptRes.json();

    if (promptRes.ok) {
      printChat("bot", `Prompt completed (stopReason: ${result.stopReason ?? "unknown"})`);
    } else {
      printChat("system", `Prompt failed: ${JSON.stringify(result)}`);
    }

    // Wait for webhook events to arrive
    await new Promise((r) => setTimeout(r, 2000));

    console.log();
    console.log("─".repeat(60));
    printChat("system", "Demo complete. Ctrl+C to exit.");
    console.log("─".repeat(60));
  } catch (err) {
    printChat("system", `Demo failed: ${err}`);
  }
});

process.on("SIGINT", () => {
  botServer.close();
  flamecast.shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  botServer.close();
  flamecast.shutdown().then(() => process.exit(0));
});
