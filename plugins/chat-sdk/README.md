# @flamecast/plugin-chat-sdk

External Chat SDK connector for Flamecast.

This package is meant to run outside Flamecast core. It receives inbound chat
events through Chat SDK, creates or reuses a backend binding for each chat
thread, and posts the end-of-turn response text back into that same thread.

## What It Does

For v1, the connector keeps the model simple:

- one connector process can manage many chat threads
- one chat thread maps to one backend binding
- bindings are kept in memory only
- inbound messages go to your backend through a caller-supplied callback
- outbound chat replies come from the callback return value

The connector does not require MCP. It only knows how to extract inbound text,
manage thread bindings, delegate webhook handling, and post non-empty replies.

## Runtime Flow

1. Chat SDK delivers a mention or subscribed-thread message.
2. The connector extracts plain text from the event.
3. If the thread is unbound, the connector:
   - subscribes the thread
   - asks your `createBinding` callback for a backend binding
4. The connector stores the in-memory `threadId -> bindingId` mapping.
5. The connector calls `onMessage({ thread, binding, text, message })`.
6. If `onMessage` returns non-empty text, the connector posts it back to the
   thread.

## HTTP Surface

`ChatSdkConnector` exposes a `fetch` handler. Mount it behind an HTTP server and
route these paths to it:

- `GET /health`
- `POST /webhooks/:platform`

`/webhooks/:platform` delegates to the matching Chat SDK webhook handler.

## Minimal Usage

```ts
import { serve } from "@hono/node-server";
import {
  ChatSdkConnector,
  FlamecastHttpClient,
  InMemoryThreadBindingStore,
} from "@flamecast/plugin-chat-sdk";

const flamecast = new FlamecastHttpClient({
  baseUrl: "http://127.0.0.1:3001",
});

const connector = new ChatSdkConnector({
  chat,
  bindings: new InMemoryThreadBindingStore(),
  createBinding: async (thread) => {
    const agent = await flamecast.createAgent({
      agentTemplateId: "codex",
    });

    return {
      threadId: thread.id,
      bindingId: agent.id,
      thread,
    };
  },
  onMessage: async ({ binding, text }) => {
    const result = await flamecast.promptAgentForReply(binding.bindingId, text);
    return result.replyText;
  },
  onBindingRemoved: async ({ bindingId }) => {
    await flamecast.terminateAgent(bindingId);
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
  Main orchestration. Installs Chat SDK handlers, manages thread bindings, and
  bridges HTTP webhook traffic.
- `src/flamecast-client.ts`
  Thin typed HTTP client for Flamecast, including a helper that derives the
  latest assistant reply text from appended session logs.
- `src/bindings.ts`
  In-memory thread-to-binding store and lookup indexes.
- `src/index.ts`
  Public package entrypoint.
- `test/connector.test.ts`
  Package-local tests. Uses fakes only and keeps coverage at 100%.

## Current Limits

- bindings are not persisted
- connector restart loses thread-to-binding mappings
- only one reply string is posted per inbound message
- Flamecast is still single-session-per-agent
