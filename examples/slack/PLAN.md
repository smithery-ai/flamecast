# Flamecast Slack Example — Implementation Plan

## Overview

A Slack bot powered by Flamecast that demonstrates webhook-based event delivery. Follows the architecture described in the [Webhooks RFC](https://flamecast.mintlify.app/rfcs/webhooks) and mirrors the pattern from `examples/webhooks-and-signaling`.

## Architecture

```
Slack ←──webhooks──→ Chat SDK Bot ←──webhooks──→ Flamecast (in-process)
                          │                           │
                     /slack/events              /flamecast/events
                     (Slack sends)              (Flamecast delivers)
                          │                           │
                          └───── REST calls ──────────┘
                            createSession()
                            promptSession()
                            resolvePermission()
```

**Key design decisions:**
- Flamecast runs **in-process** (same as all other examples)
- Events delivered via **webhooks** (not SSE) — matches RFC and `examples/webhooks-and-signaling`
- Global webhook registered on the Flamecast instance pointing at the bot's own `/flamecast/events` endpoint
- Permissions **deferred** (no `onPermissionRequest` handler) — Flamecast delivers `permission_request` via webhook, bot posts to Slack, user responds, bot calls `resolvePermission()` via REST
- REST client (`createFlamecastClient`) talks to the in-process server over HTTP (same pattern as `examples/webhooks-and-signaling/run-demo.ts`)

## What this uses from the SDK

All of these exist and are tested (PR #76):

| SDK Feature | How the bot uses it |
|---|---|
| `new Flamecast({ webhooks, runtimes })` | Creates instance with global webhook |
| `FlamecastOptions.webhooks` | Registers `BOT_URL/flamecast/events` for all sessions |
| `createFlamecastClient({ baseUrl })` | REST client for session/prompt/permission calls |
| `client.createSession({ agentTemplateId })` | Creates agent session on mention |
| `client.promptSession(id, text)` | Forwards Slack messages as prompts |
| `client.resolvePermission(id, reqId, body)` | Resolves permissions from Slack user input |
| `verifyWebhookSignature(secret, body, sig)` | Verifies incoming webhook signatures |
| Webhook event types | `end_turn`, `permission_request`, `error`, `session_end` |
| `startServer()` from shared helper | Server lifecycle management |

## Directory Structure

```
examples/slack/
  src/
    index.ts            # Entry point: Flamecast instance + HTTP server
    bot.ts              # Chat SDK bot: Slack event handlers
    webhooks.ts         # Flamecast webhook receiver: routes events to Slack threads
  package.json
  tsconfig.json
  .env.example
  README.md
```

## File-by-File Implementation

---

### `package.json`

```json
{
  "name": "@flamecast/example-slack",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts"
  },
  "dependencies": {
    "@flamecast/example-shared": "workspace:*",
    "@flamecast/sdk": "workspace:*",
    "@flamecast/protocol": "workspace:*",
    "chat": "latest",
    "@chat-adapter/slack": "latest",
    "@chat-adapter/state-memory": "latest",
    "@hono/node-server": "^1.19.11",
    "hono": "^4.12.8"
  },
  "devDependencies": {
    "tsx": "^4.21.0"
  },
  "packageManager": "pnpm@10.26.2"
}
```

---

### `tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "jsxImportSource": "chat"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

---

### `.env.example`

```bash
# Slack App credentials (from api.slack.com/apps)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...

# Public URL where this bot is reachable (ngrok for local dev)
BOT_URL=https://your-bot.ngrok.io

# Session host URL (default: http://localhost:8787)
# Start with: pnpm --filter @flamecast/session-host dev
RUNTIME_URL=http://localhost:8787

# Webhook signing secret (shared between Flamecast and the receiver)
WEBHOOK_SECRET=my-webhook-secret
```

---

### `src/index.ts`

Follows the same pattern as `examples/webhooks-and-signaling/index.ts`:
- Creates Flamecast instance with global webhook
- Creates REST client pointed at own server
- Starts HTTP server serving both Slack events and Flamecast API

```typescript
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
  // This is the same pattern as examples/webhooks-and-signaling/index.ts line 24.
  webhooks: [{ url: `${botUrl}/flamecast/events`, secret: webhookSecret }],

  // No onPermissionRequest handler — permissions are deferred.
  // Flamecast sets session.pendingPermission and delivers a permission_request
  // webhook event. The bot posts to Slack and resolves via REST.
  // (See handlePermissionRequest in index.ts line 793: returns undefined when
  // no handler is registered, resulting in { deferred: true }.)

  onSessionEnd: async (c) => {
    console.log(`[flamecast] Session ended (${c.reason})`);
  },
});

// ---------------------------------------------------------------------------
// REST client (talks to our own in-process server, same as run-demo.ts)
// ---------------------------------------------------------------------------

const apiUrl = `http://localhost:${port}/api`;
const client = createFlamecastClient({ baseUrl: apiUrl });

// ---------------------------------------------------------------------------
// Chat SDK bot + webhook handler
// ---------------------------------------------------------------------------

const bot = createBot(client);
const handleWebhook = createWebhookHandler(bot, webhookSecret);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = new Hono();

// Slack events (mentions, messages, button clicks)
app.post("/slack/events", (c) => bot.webhooks.slack(c.req.raw));

// Flamecast webhook events (end_turn, permission_request, error, session_end)
app.post("/flamecast/events", (c) => handleWebhook(c.req.raw));

// Flamecast API (sessions, prompts, permissions)
app.route("/", flamecast.app);

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
```

---

### `src/bot.ts`

Chat SDK bot. Handles Slack events and calls the Flamecast REST client.

The bot does three things:
1. `onNewMention` — creates a Flamecast session, sends the mention text as first prompt
2. `onSubscribedMessage` — forwards follow-up messages as prompts, or resolves permissions
3. `onAction` — handles button clicks for permission approval/denial

```typescript
import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { createFlamecastClient } from "@flamecast/sdk/client";

type FlamecastClient = ReturnType<typeof createFlamecastClient>;

interface ThreadState {
  sessionId: string;
  pendingPermission?: {
    requestId: string;
    options: Array<{ optionId: string; name: string; kind: string }>;
  } | null;
}

// Reverse lookup: sessionId -> threadId (used by webhook handler)
export const sessionThreads = new Map<string, string>();

export function createBot(client: FlamecastClient): Chat {
  const bot = new Chat({
    userName: "flamecast-agent",
    adapters: { slack: createSlackAdapter() },
    state: createMemoryState(),
  });

  // --- New mention: create session + send first prompt ---

  bot.onNewMention(async (thread, message) => {
    await thread.subscribe();

    const session = await client.createSession({
      agentTemplateId: process.env.AGENT_TEMPLATE_ID || "example",
    });

    await thread.setState<ThreadState>({ sessionId: session.id });
    sessionThreads.set(session.id, thread.id);

    await client.promptSession(session.id, message.text);
    await thread.post("_Working on it..._");
  });

  // --- Subscribed message: forward as prompt or handle permission ---

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.isMe) return;

    const state = await thread.getState<ThreadState>();
    if (!state?.sessionId) return;

    const text = message.text.trim().toLowerCase();

    // Check if this is a permission response
    if (state.pendingPermission) {
      if (["allow", "approve", "yes"].includes(text)) {
        await client.resolvePermission(
          state.sessionId,
          state.pendingPermission.requestId,
          { optionId: state.pendingPermission.options[0].optionId },
        );
        await thread.setState<ThreadState>({ ...state, pendingPermission: null });
        await thread.post("_Permission granted._");
        return;
      }
      if (["deny", "reject", "no"].includes(text)) {
        await client.resolvePermission(
          state.sessionId,
          state.pendingPermission.requestId,
          { outcome: "cancelled" },
        );
        await thread.setState<ThreadState>({ ...state, pendingPermission: null });
        await thread.post("_Permission denied._");
        return;
      }
    }

    // Otherwise forward as a prompt
    await client.promptSession(state.sessionId, message.text);
  });

  // --- Button handlers (for card-based permission flow) ---

  bot.onAction("fc_allow", async (event) => {
    const state = await event.thread.getState<ThreadState>();
    if (!state?.sessionId || !state.pendingPermission) return;
    await client.resolvePermission(
      state.sessionId,
      state.pendingPermission.requestId,
      { optionId: event.value! },
    );
    await event.thread.setState<ThreadState>({ ...state, pendingPermission: null });
    await event.thread.post("_Permission granted._");
  });

  bot.onAction("fc_deny", async (event) => {
    const state = await event.thread.getState<ThreadState>();
    if (!state?.sessionId || !state.pendingPermission) return;
    await client.resolvePermission(
      state.sessionId,
      state.pendingPermission.requestId,
      { outcome: "cancelled" },
    );
    await event.thread.setState<ThreadState>({ ...state, pendingPermission: null });
    await event.thread.post("_Permission denied._");
  });

  return bot;
}
```

---

### `src/webhooks.ts`

Webhook receiver. Mirrors `examples/webhooks-and-signaling/webhook-receiver.ts` but routes events to Slack threads instead of logging to console.

```typescript
/**
 * Receives Flamecast webhook events and routes them to Slack threads.
 *
 * Same verification pattern as examples/webhooks-and-signaling/webhook-receiver.ts.
 * Uses verifyWebhookSignature from @flamecast/protocol/verify.
 */
import { verifyWebhookSignature } from "@flamecast/protocol/verify";
import type { WebhookPayload } from "@flamecast/protocol";
import type { Chat } from "chat";
import { sessionThreads } from "./bot.js";

export function createWebhookHandler(bot: Chat, secret: string) {
  return async function handleWebhook(req: Request): Promise<Response> {
    const body = await req.text();
    const sig = req.headers.get("x-flamecast-signature");

    if (!sig || !verifyWebhookSignature(secret, body, sig)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const payload: WebhookPayload = JSON.parse(body);
    const { sessionId, event } = payload;

    // Find the Slack thread for this session
    const threadId = sessionThreads.get(sessionId);
    if (!threadId) {
      console.warn(`[webhook] No thread found for session ${sessionId}`);
      return new Response("OK");
    }

    const thread = bot.thread(threadId);

    switch (event.type) {
      case "end_turn": {
        // Agent finished processing a prompt
        const response = event.data.promptResponse;
        if (typeof response === "string") {
          await thread.post(response);
        } else if (response && typeof response === "object") {
          await thread.post(JSON.stringify(response, null, 2));
        } else {
          await thread.post("_Agent completed._");
        }
        break;
      }

      case "permission_request": {
        // Agent requests permission — post to Slack thread
        const data = event.data as {
          requestId: string;
          title: string;
          options: Array<{ optionId: string; name: string; kind: string }>;
        };

        // Store pending permission in thread state
        const state = (await thread.getState<any>()) ?? {};
        await thread.setState({
          ...state,
          pendingPermission: {
            requestId: data.requestId,
            options: data.options,
          },
        });

        // Text-based prompt (works everywhere).
        // To use JSX cards with Allow/Deny buttons, rename this file to .tsx and use:
        //
        //   import { Card, Section, Text, Actions, Button } from "chat";
        //   await thread.post(
        //     <Card title="Permission Request">
        //       <Section><Text>{data.title}</Text></Section>
        //       <Actions>
        //         <Button actionId="fc_allow" style="primary" value={data.options[0]?.optionId}>Allow</Button>
        //         <Button actionId="fc_deny" style="danger" value={data.requestId}>Deny</Button>
        //       </Actions>
        //     </Card>
        //   );
        await thread.post(
          `**Permission requested:** ${data.title}\nReply "allow" or "deny".`,
        );
        break;
      }

      case "error": {
        const message = typeof event.data.message === "string"
          ? event.data.message
          : "Unknown error";
        await thread.post(`*Error:* ${message}`);
        break;
      }

      case "session_end": {
        await thread.post("_Agent session ended._");
        sessionThreads.delete(sessionId);
        break;
      }
    }

    return new Response("OK");
  };
}
```

---

### `README.md` outline

1. What this does (Slack bot backed by Flamecast agent sessions)
2. Architecture diagram (webhook-based, matches RFC)
3. Prerequisites: Node.js, Slack workspace, ngrok for local dev
4. Slack App setup: create app, required scopes, event subscriptions
5. Environment variables (reference .env.example)
6. Running: start session-host + bot
7. Usage: mention bot → session created → agent responds in thread
8. Permission flow: agent requests permission → bot posts to Slack → user replies
9. Production notes: swap state-memory for state-redis, persist sessionThreads

---

## Implementation Notes

### Grounding references

| Plan element | Grounded in |
|---|---|
| `new Flamecast({ webhooks: [...] })` | `examples/webhooks-and-signaling/index.ts` line 24 |
| `createFlamecastClient({ baseUrl })` | `examples/webhooks-and-signaling/run-demo.ts` line 8 |
| `verifyWebhookSignature(secret, body, sig)` | `examples/webhooks-and-signaling/webhook-receiver.ts` line 15 |
| No `onPermissionRequest` = deferred | `packages/flamecast/src/flamecast/index.ts` line 793 |
| `client.resolvePermission()` | `POST /api/agents/:id/permissions/:requestId` from PR #76 |
| `client.createSession()` / `client.promptSession()` | `packages/flamecast/src/client/api.ts` |
| `WebhookPayload` type | `packages/protocol/src/session.ts` lines 146-154 |
| Webhook event types | `packages/flamecast/src/flamecast/index.ts` lines 746-751 |
| `startServer` / `waitForSessionHost` | `examples/shared/create-example.ts` |

### Things the implementing agent should verify

1. **`WebhookPayload` import path** — Check if it's exported from `@flamecast/protocol` directly or needs `@flamecast/protocol/session`. Look at `packages/protocol/src/index.ts` exports.

2. **`bot.thread(threadId)`** — Verify this chat-sdk method works outside of event handler context (needed by webhook receiver). If not, the receiver may need to use a different approach to post to threads.

3. **`end_turn` event data shape** — The `data.promptResponse` field should be checked against actual webhook delivery output. The `run-demo.ts` just calls `promptSession()` and gets a result directly — the webhook payload for `end_turn` may structure data differently.

4. **`client.resolvePermission()` method name** — Verify the exact method name in `packages/flamecast/src/client/api.ts`. It may be `resolvePermission` or something else.

5. **Chat SDK package names** — npm packages are `chat`, `@chat-adapter/slack`, `@chat-adapter/state-memory`. NOT `chat-sdk`.

### What the mintlify guide gets wrong

The guide at `https://flamecast.mintlify.app/guides/slackbot` references APIs that don't exist:
- `FlamecastSession` class — doesn't exist. Use `createFlamecastClient()` REST + webhooks.
- `import { Chat } from "chat-sdk"` — wrong package name. It's `import { Chat } from "chat"`.
- `session.on(event)` — no WS client wrapper. Use webhook delivery.
- `bot.onReply()` — not a chat-sdk method. It's `bot.onSubscribedMessage()`.

The guide should be updated to match this implementation once it ships.
