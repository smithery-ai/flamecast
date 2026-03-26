/**
 * Example: Approval Queue
 *
 * An interactive terminal where you approve or deny agent permission
 * requests in real time. Demonstrates the async webhook permission flow:
 *
 *   1. Agent requests permission → webhook delivers to this process
 *   2. You type "y" or "n" in the terminal
 *   3. Your response is sent via POST /permissions/:requestId
 *   4. Agent continues (or skips the action)
 *
 * This is how a Slack bot or approval UI would work — the agent blocks
 * until an external system responds, with no WebSocket connection needed.
 *
 * Run:
 *   pnpm --filter @flamecast/session-host --filter @flamecast/example-approval-queue dev
 *
 * Then send prompts from another terminal:
 *   curl -s -X POST http://localhost:3003/api/agents \
 *     -H 'Content-Type: application/json' \
 *     -d '{"agentTemplateId": "example", "webhooks": [{"url": "http://localhost:3004/events", "secret": "demo"}]}' | jq .id
 *
 *   curl -s -X POST http://localhost:3003/api/agents/SESSION_ID/prompts \
 *     -H 'Content-Type: application/json' \
 *     -d '{"text": "write a file to disk"}'
 */
import * as readline from "node:readline";
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
const FLAMECAST_URL = `http://localhost:${FLAMECAST_PORT}/api`;

// ---------------------------------------------------------------------------
// Pending permission queue
// ---------------------------------------------------------------------------

interface PendingPermission {
  sessionId: string;
  requestId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

const queue: PendingPermission[] = [];
let waitingForInput = false;

function promptNext(): void {
  if (queue.length === 0 || waitingForInput) return;

  const item = queue[0];
  const options = item.options.map((o) => o.name).join(" / ");
  process.stdout.write(`\n  [PENDING] "${item.title}" [${options}]\n  approve? (y/n): `);
  waitingForInput = true;
}

async function handleAnswer(answer: string): Promise<void> {
  const item = queue.shift();
  waitingForInput = false;
  if (!item) return;

  const approved = answer.trim().toLowerCase().startsWith("y");
  const option = item.options.find((o) =>
    approved ? o.kind.startsWith("allow") : o.kind.startsWith("reject"),
  );

  if (!option) {
    console.log(`  ⚠ No matching option — cancelling`);
    await fetch(`${FLAMECAST_URL}/agents/${item.sessionId}/permissions/${item.requestId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "cancelled" }),
    });
  } else {
    console.log(approved ? `  ✓ Approved` : `  ✗ Denied`);
    await fetch(`${FLAMECAST_URL}/agents/${item.sessionId}/permissions/${item.requestId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: option.optionId }),
    });
  }

  promptNext();
}

// ---------------------------------------------------------------------------
// Webhook receiver
// ---------------------------------------------------------------------------

const botServer = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();

  // Verify signature
  const secret = req.headers["x-flamecast-secret"] ?? "demo";
  const signature = req.headers["x-flamecast-signature"];
  if (typeof signature === "string" && typeof secret === "string") {
    if (!verifyWebhookSignature(secret, body, signature)) {
      res.writeHead(401);
      res.end("invalid signature");
      return;
    }
  }

  const payload = JSON.parse(body);
  const { event, sessionId } = payload;

  switch (event.type) {
    case "permission_request":
      queue.push({
        sessionId,
        requestId: event.data.requestId,
        title: event.data.title,
        options: event.data.options,
      });
      promptNext();
      break;

    case "end_turn":
      console.log(`\n  → Agent turn complete`);
      promptNext();
      break;

    case "session_end":
      console.log(`\n  → Session ended (exit code: ${event.data.exitCode})`);
      promptNext();
      break;

    case "error":
      console.log(`\n  → Error: ${event.data.message}`);
      promptNext();
      break;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

// ---------------------------------------------------------------------------
// Flamecast server — permissions deferred to webhook
// ---------------------------------------------------------------------------

const flamecast = new Flamecast({
  runtimes: { default: new NodeRuntime() },
  agentTemplates: [
    {
      id: "example",
      name: "Example agent",
      spawn: { command: "pnpm", args: ["exec", "tsx", agentPath] },
      runtime: { provider: "default" },
    },
  ],
  onPermissionRequest: async () => undefined, // defer to webhook
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  if (waitingForInput) void handleAnswer(line);
});

botServer.listen(BOT_PORT, () => {
  console.log(`  Webhook receiver on http://localhost:${BOT_PORT}`);
});

serve({ fetch: flamecast.app.fetch, port: FLAMECAST_PORT }, () => {
  console.log(`  Flamecast on http://localhost:${FLAMECAST_PORT}`);
  console.log();
  console.log(`  Create a session with webhooks, then send a prompt:`);
  console.log();
  console.log(`    SESSION=$(curl -s -X POST http://localhost:${FLAMECAST_PORT}/api/agents \\`);
  console.log(`      -H 'Content-Type: application/json' \\`);
  console.log(
    `      -d '{"agentTemplateId":"example","webhooks":[{"url":"http://localhost:${BOT_PORT}/events","secret":"demo"}]}' | jq -r .id)`,
  );
  console.log();
  console.log(
    `    curl -s -X POST http://localhost:${FLAMECAST_PORT}/api/agents/$SESSION/prompts \\`,
  );
  console.log(`      -H 'Content-Type: application/json' \\`);
  console.log(`      -d '{"text":"write a file to disk"}'`);
  console.log();
  console.log(`  Waiting for permission requests...`);
});

process.on("SIGINT", () => {
  rl.close();
  botServer.close();
  flamecast.shutdown().then(() => process.exit(0));
});
