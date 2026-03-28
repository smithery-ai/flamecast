# Flamecast Slack Bot Example

A Slack bot backed by Flamecast agent sessions. Demonstrates **webhook-based event delivery** — the bot receives agent responses and permission requests via HTTP webhooks rather than WebSocket/SSE.

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

- Flamecast runs **in-process** (same Hono server as the bot)
- Events delivered via **webhooks** with HMAC signatures
- Permissions are **deferred** — delivered as webhook events, resolved via REST after user input in Slack

## Prerequisites

- Node.js 20+
- A Slack workspace where you can install apps
- [ngrok](https://ngrok.com/) (or similar) for local development

## Slack App Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
3. Under **Event Subscriptions**:
   - Enable events
   - Set Request URL to `https://your-ngrok-url/slack/events`
   - Subscribe to: `app_mention`, `message.im`
4. Under **Interactivity & Shortcuts**:
   - Enable interactivity
   - Set Request URL to `https://your-ngrok-url/slack/events`
5. Install the app to your workspace and copy the **Bot User OAuth Token** and **Signing Secret**

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Signing Secret from app credentials |
| `BOT_URL` | Public URL for your bot (ngrok URL) |
| `RUNTIME_URL` | Session host URL (default: `http://localhost:8787`) |
| `WEBHOOK_SECRET` | Shared secret for Flamecast webhook signatures |

## Running

Start the session host and the bot together:

```bash
pnpm --filter @flamecast/session-host --filter @flamecast/example-slack dev
```

Or separately:

```bash
# Terminal 1: session host
pnpm --filter @flamecast/session-host dev

# Terminal 2: slack bot
pnpm --filter @flamecast/example-slack dev
```

## Usage

1. Mention the bot in any channel: `@flamecast-agent write hello world to /tmp/test.txt`
2. The bot creates a Flamecast session, sends the prompt, and replies with results in a thread
3. Send follow-up messages in the thread to continue the conversation

### Permission Flow

When the agent requests permission (e.g., to write a file):

1. Flamecast delivers a `permission_request` webhook to the bot
2. The bot posts to the Slack thread: "Permission requested: ... Reply allow or deny."
3. User replies `allow` or `deny`
4. The bot resolves the permission via the Flamecast REST API
5. The agent continues (or stops)

## Production Notes

- Replace `@chat-adapter/state-memory` with `@chat-adapter/state-redis` for persistence across restarts
- The `sessionThreads` map is in-memory — for production, store session-to-thread mappings in your database
- Use a proper secret for `WEBHOOK_SECRET` (not the default `demo-secret`)
