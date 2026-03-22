# @flamecast/plugin-chat-sdk

External Chat SDK connector for Flamecast.

This package is meant to run outside Flamecast core. It receives inbound chat
events through Chat SDK, creates or reuses a Flamecast agent for each chat
thread, and posts the end-of-turn response text back into that same thread.

## What It Does

For v1, the connector keeps the model simple:

- one connector process can manage many chat threads
- one chat thread maps to one Flamecast agent
- the thread-to-agent mapping is kept in memory only
- inbound messages are forwarded directly to Flamecast
- outbound chat replies come directly from Flamecast session logs

The connector does not require MCP. It only knows how to extract inbound text,
manage thread bindings, delegate webhook handling, and post non-empty replies.

## Runtime Flow

1. Chat SDK delivers a mention or subscribed-thread message.
2. The connector extracts plain text from the event.
3. If the thread is unbound, the connector:
   - subscribes the thread
   - creates a Flamecast agent from the configured `CreateSessionBody`
4. The connector stores the in-memory `threadId -> agentId` mapping.
5. The connector prompts that agent through Flamecast.
6. If Flamecast appends a non-empty assistant reply, the connector posts it
   back to the thread.

## HTTP Surface

`ChatSdkConnector` exposes a `fetch` handler. Mount it behind an HTTP server and
route these paths to it:

- `GET /health`
- `POST /webhooks/:platform`

`/webhooks/:platform` delegates to the matching Chat SDK webhook handler.

## Minimal Usage

```ts
import { serve } from "@hono/node-server";
import type { AppType } from "@acp/flamecast/api";
import { hc } from "hono/client";
import { ChatSdkConnector } from "@flamecast/plugin-chat-sdk";

const flamecast = hc<AppType>("http://127.0.0.1:3001/api");

const connector = new ChatSdkConnector({
  chat,
  flamecast,
  agent: {
    agentTemplateId: "codex",
  },
});

connector.start();

serve({
  fetch: connector.fetch,
  port: 3002,
});
```

Expected collaborators:

- `chat` must provide:
  - `onNewMention(handler)`
  - `onSubscribedMessage(handler)`
  - `webhooks[platform](request, { waitUntil })`
- Flamecast must expose:
  - `POST /api/agents`
  - `GET /api/agents/:agentId`
  - `POST /api/agents/:agentId/prompt`
  - `DELETE /api/agents/:agentId`

## Package Structure

- `src/connector.ts`
  Main orchestration. Installs Chat SDK handlers, creates Flamecast agents,
  prompts them, tracks thread-to-agent bindings in memory, and bridges HTTP
  webhook traffic.
- `src/index.ts`
  Public package entrypoint.
- `test/connector.test.ts`
  Package-local tests. Uses fakes only and keeps coverage at 100%.

## Current Limits

- bindings are not persisted
- connector restart loses thread-to-agent mappings
- only one reply string is posted per inbound message
- Flamecast is still single-session-per-agent
