# SMI-1704: Multi-Session WebSocket Adapter with Channel Subscriptions

## Context

Today each session requires its own WebSocket connection directly to its session-host process (1:1 model). The control plane (`Flamecast` class + Hono API) is HTTP-only. Session-hosts POST callback events to `/api/agents/:id/events`, but the control plane has no way to push real-time events to browser clients.

This doesn't scale for tabbed editors (10 sessions = 10 connections), dashboards monitoring all agents, or UIs that need filtered event streams. The RFC at `apps/docs/rfcs/multi-session-websocket.mdx` specifies the target architecture.

**Goal:** Add a server-side WS multiplexer on the control plane with channel-based subscriptions, composed React hooks sharing a single connection, and backward compatibility with the existing per-session WS model.

---

## Architecture

```
Browser (single WS) ──ws──> ws://localhost:3001/ws
                              │
                         WsAdapter (new)
                         ┌──────────────────────┐
                         │ channelToClients map  │
                         │ subscribe/unsubscribe │
                         │ routeEvent()          │
                         └──────┬───────────────┘
                                │ listens to
                         EventBus (new)
                                │ emitted from
                    Flamecast.handleSessionEvent()
                                ▲
                    session-host POST /api/agents/:id/events
```

**Key decision:** Event ingestion via callback fan-out (not WS proxy to session-hosts). Session-hosts already POST events to the control plane. We add an internal `EventBus` that `handleSessionEvent()` publishes to, and the WS adapter subscribes to.

---

## Build Order

### Step 1: Protocol types
### Step 2: EventBus + ChannelRouter (pure logic, unit-testable)
### Step 3: WsAdapter + Flamecast integration (server-side WS endpoint)
### Step 4: Client-side FlamecastConnection + FlamecastProvider + hooks

Steps 1-3 form **PR 1** (server infra). Step 4 is **PR 2** (client hooks).

The REST endpoint `POST /api/agents/:agentId/sessions` (multi-session per agent) is deferred — it requires session-host changes to support multiple ACP sessions on one process.

---

## Step 1: Protocol Types

### NEW `packages/protocol/src/ws-channels.ts`

Channel-based WS message types, separate from existing `ws.ts` (backward compat).

**Client-to-Server actions:**
- `subscribe` / `unsubscribe` — `{ action, channel }`
- `prompt` — `{ action, sessionId, text }`
- `permission.respond` — `{ action, sessionId, requestId, body }`
- `cancel` — `{ action, sessionId, queueId? }`
- `terminate` — `{ action, sessionId }`
- `session.create` — `{ action, agentId }`
- `ping`

**Server-to-Client messages:**
- `connected` — `{ type, connectionId }`
- `subscribed` / `unsubscribed` — `{ type, channel }`
- `event` — `{ type, channel, sessionId, agentId?, event: { type, data, timestamp } }`
- `session.created` / `session.terminated` — lifecycle
- `error` — `{ type, message, channel? }`

**Channel strings:** `agents`, `agent:{agentId}`, `session:{sessionId}`, `session:{sessionId}:terminal`, `session:{sessionId}:terminal:{terminalId}`, `session:{sessionId}:queue`, `session:{sessionId}:fs`, `agent:{agentId}:fs`

### MODIFY `packages/protocol/package.json`

Add export `"./ws/channels"`.

### MODIFY `packages/protocol/src/index.ts`

Re-export new types.

---

## Step 2: EventBus + ChannelRouter

### NEW `packages/flamecast/src/flamecast/event-bus.ts`

Typed wrapper around `node:events` EventEmitter:

```ts
interface ChannelEvent {
  sessionId: string;
  agentId?: string;
  event: { type: string; data: Record<string, unknown>; timestamp: string };
}
```

- `emit("event", channelEvent)` — publish a session event
- `emit("session.created" | "session.terminated", data)` — lifecycle
- `on(eventName, listener)` — returns unsubscribe function
- **History ring buffer:** `Map<sessionId, ChannelEvent[]>`, capped at 1000 per session
- `getHistory(sessionId, filter?)` — for replay on subscribe
- `clearHistory(sessionId)` — called 60s after session termination

### NEW `packages/flamecast/src/flamecast/channel-router.ts`

Pure function: `eventToChannels(event: ChannelEvent): string[]`

Maps an event to all channel strings it belongs to:
- Every event belongs to `session:{sessionId}`
- Terminal events (rpc where `data.method` contains "terminal") also belong to `session:{id}:terminal` (and `session:{id}:terminal:{terminalId}` if `data.terminalId` present)
- Queue events (`type` starts with "queue" or is "prompt_queued"/"prompt_dequeued") also to `session:{id}:queue`
- FS events (`type` starts with "filesystem") also to `session:{id}:fs` and `agent:{agentId}:fs`
- If `agentId` present, also to `agent:{agentId}`

Classification helpers: `isTerminalEvent()`, `isQueueEvent()`, `isFsEvent()`

---

## Step 3: WsAdapter + Flamecast Integration

### NEW `packages/flamecast/src/flamecast/ws-adapter.ts`

Core server-side component.

**Data structures:**
```ts
interface ClientConnection {
  id: string;              // connectionId (UUID)
  ws: WebSocket;
  subscriptions: Set<string>;
}

class WsAdapter {
  clients: Map<string, ClientConnection>;
  channelToClients: Map<string, Set<string>>;  // reverse index
}
```

**WS attachment strategy:**

`@hono/node-server`'s `serve()` returns `ServerType` which is `http.Server`. Create `WebSocketServer({ noServer: true })` and listen for `upgrade` events on the HTTP server at path `/ws`:

```ts
server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url, "http://localhost").pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws));
  }
  // Other paths pass through (backward compat)
});
```

**Connection lifecycle:**
1. On connect: assign `connectionId`, send `{ type: "connected", connectionId }`
2. On message: parse JSON, dispatch by `action` field
3. On close: remove client from all channel sets

**Subscribe flow:**
1. Check `maxSubscriptionsPerConnection` (100)
2. Add client to `channelToClients` map
3. Send `{ type: "subscribed", channel }`
4. Replay history from EventBus (add to channel listeners FIRST, then replay to avoid race)

**Event routing (`routeEvent`):**
1. Call `eventToChannels(event)` to get all matching channel strings
2. Iterate channels, look up `channelToClients` for each
3. **Deduplication:** Track `Set<connectionId>` per event — each client gets the event at most once, tagged with the most specific channel they're subscribed to

**History replay strategy:**
- `session:{id}` — replay full history buffer
- `session:{id}:terminal` — replay only terminal events
- `session:{id}:queue` — replay only latest queue state event
- `session:{id}:fs` — replay only latest `filesystem.changed` event

**Command proxying:**
- `prompt` → `flamecast.promptSession(sessionId, text)`
- `terminate` → `flamecast.terminateSession(sessionId)`
- `permission.respond` → `sessionService.proxyRequest(sessionId, "/permission", ...)`
- `session.create` → create session, auto-subscribe client to new session channel

### MODIFY `packages/flamecast/src/flamecast/index.ts`

1. Add `EventBus` as private member, created in constructor
2. Expose `readonly eventBus: EventBus` (or expose via `attachWebSocket` only)
3. In `handleSessionEvent()` — after dispatching to handlers, emit to eventBus:
   ```ts
   this.eventBus.emit("event", { sessionId, event: { type: event.type, data: event.data, timestamp: new Date().toISOString() } });
   ```
4. In `createSession()` — emit `"session.created"` lifecycle event
5. In `terminateSession()` — emit `"session.terminated"` lifecycle event
6. Add `attachWebSocket(server: ServerType): void` public method — creates WsAdapter

### MODIFY `apps/server/src/index.ts`

Capture `serve()` return value, call `attachWebSocket()`:

```ts
// Before:
serve({ fetch: flamecast.app.fetch, port: 3001 }, (info) => { ... });

// After:
const server = serve({ fetch: flamecast.app.fetch, port: 3001 }, (info) => { ... });
flamecast.attachWebSocket(server);
```

### MODIFY `packages/flamecast/package.json`

Add dependency: `"ws": "^8.18.0"`, devDep: `"@types/ws": "^8.18.1"`

---

## Step 4: Client-Side Hooks

### NEW `packages/flamecast/src/client/lib/flamecast-connection.ts`

Shared WS connection manager with ref-counted subscriptions:

- Single WebSocket to `ws://localhost:3001/ws`
- `subscribe(channel, listener)` → returns unsubscribe fn
- Ref counting: first subscriber sends WS `subscribe`, last unsubscriber sends `unsubscribe`
- Auto-reconnect with exponential backoff (same pattern as existing `FlamecastSession`)
- On reconnect, re-sends all active subscriptions (`resendSubscriptions()`)
- `sendAction(msg)` — for prompt, terminate, etc.
- Connection states: `disconnected | connecting | connected | reconnecting`

### NEW `packages/flamecast/src/client/lib/flamecast-context.ts`

React Context holding `FlamecastConnection`. `useFlamecastContext()` throws if not in provider.

### NEW `packages/flamecast/src/client/components/flamecast-provider.tsx`

```tsx
<FlamecastProvider url="ws://localhost:3001/ws">
  {children}
</FlamecastProvider>
```

Creates `FlamecastConnection` in a ref, connects on mount, disconnects on unmount.

### NEW `packages/flamecast/src/client/hooks/use-flamecast.ts`

Exposes `connection`, `connectionState`, `isConnected` via `useSyncExternalStore`.

### NEW `packages/flamecast/src/client/hooks/use-session.ts`

Subscribes to `session:{sessionId}`. Returns `{ events, prompt, respondToPermission, cancel, terminate }`. Uses `useSyncExternalStore` with accumulated `SessionLog[]` in a ref.

### NEW `packages/flamecast/src/client/hooks/use-terminal.ts`

Subscribes to `session:{sessionId}:terminal`. Returns `{ terminals, activeTerminal, sendInput, resize }`.

### NEW `packages/flamecast/src/client/hooks/use-queue.ts`

Subscribes to `session:{sessionId}:queue`. Returns `{ items, processing, paused, cancel, clear, reorder, pause, resume }`.

### NEW `packages/flamecast/src/client/hooks/use-file-system.ts`

Overloaded: `useFileSystem(sessionId)` subscribes to `session:{id}:fs`; `useFileSystem({ agentId })` subscribes to `agent:{id}:fs`. Returns `{ files, requestPreview }`.

### NEW `packages/flamecast/src/client/hooks/use-agent.ts`

Subscribes to `agent:{agentId}`. Returns `{ sessions: Map<id, SessionState>, createSession, prompt, respondToPermission, terminate }`.

### UNCHANGED (backward compat)

- `packages/flamecast/src/client/hooks/use-flamecast-session.ts` — existing per-session hook, untouched
- `packages/flamecast/src/client/lib/flamecast-session.ts` — existing per-session WS client, untouched
- `packages/protocol/src/ws.ts` — existing message types, untouched

---

## Files Summary

| File | Action | Step |
|------|--------|------|
| `packages/protocol/src/ws-channels.ts` | NEW | 1 |
| `packages/protocol/src/index.ts` | MODIFY | 1 |
| `packages/protocol/package.json` | MODIFY | 1 |
| `packages/flamecast/src/flamecast/event-bus.ts` | NEW | 2 |
| `packages/flamecast/src/flamecast/channel-router.ts` | NEW | 2 |
| `packages/flamecast/src/flamecast/ws-adapter.ts` | NEW | 3 |
| `packages/flamecast/src/flamecast/index.ts` | MODIFY | 3 |
| `packages/flamecast/package.json` | MODIFY | 3 |
| `apps/server/src/index.ts` | MODIFY | 3 |
| `packages/flamecast/src/client/lib/flamecast-connection.ts` | NEW | 4 |
| `packages/flamecast/src/client/lib/flamecast-context.ts` | NEW | 4 |
| `packages/flamecast/src/client/components/flamecast-provider.tsx` | NEW | 4 |
| `packages/flamecast/src/client/hooks/use-flamecast.ts` | NEW | 4 |
| `packages/flamecast/src/client/hooks/use-session.ts` | NEW | 4 |
| `packages/flamecast/src/client/hooks/use-terminal.ts` | NEW | 4 |
| `packages/flamecast/src/client/hooks/use-queue.ts` | NEW | 4 |
| `packages/flamecast/src/client/hooks/use-file-system.ts` | NEW | 4 |
| `packages/flamecast/src/client/hooks/use-agent.ts` | NEW | 4 |

---

## Key Design Decisions

1. **Callback fan-out (not WS proxy):** Session-hosts already POST events. We emit from `handleSessionEvent()` to an EventBus. No new connections to session-hosts. Works with Docker/remote runtimes.

2. **Stateless reconnection:** Client re-sends subscribes on reconnect. History replay covers the gap. Simpler than server-side subscription persistence.

3. **In-memory history:** EventBus stores events in a ring buffer. Lost on server restart. Acceptable for MVP.

4. **Event deduplication:** If a client subscribes to both `agent:X` and `session:Y`, each event delivered once, tagged with the most specific matching channel.

5. **agentId mapping:** Currently `agentId === sessionId` (1:1 model). The channel router accepts optional `agentId` in `ChannelEvent`. When multi-session-per-agent lands, the real `agentId` will flow through.

6. **`ws` package:** Already used by session-host. Gives full control via `noServer` mode + `upgrade` event. Added to `@flamecast/sdk` server-side only (won't leak into client bundle since `src/client/**` is excluded from package build).

---

## Potential Risks

- **Event fidelity:** The control plane only receives events that session-hosts POST via callback (permission, lifecycle, agent_message, error). Real-time RPC events currently go direct to session-host WS clients, NOT through the control plane. For full event fidelity in the multiplexer, session-hosts may need to POST all events. Start with what we have; extend session-host callback scope if needed.

- **`serve()` return type:** Verified `@hono/node-server@1.19.11` `serve()` returns `ServerType = Server | Http2Server | Http2SecureServer`. Default config returns `http.Server`. The `on("upgrade")` handler works directly.

- **Vite bundling:** The `ws` import in server-side `ws-adapter.ts` must not leak into the client Vite build. The existing `tsconfig.package.json` excludes `src/client/**` for the server build; the Vite config needs `ws` marked as external/excluded.

---

## Verification

1. **Unit tests:** EventBus (emit/receive/history/cap), ChannelRouter (event classification, channel mapping), WsAdapter (subscribe/unsubscribe/routing/dedup/history replay/max subscriptions)
2. **Integration test:** Create Flamecast with mock runtime → `attachWebSocket(server)` → create session via REST → connect WS client to `/ws` → subscribe to `session:{id}` → POST callback event to `/api/agents/{id}/events` → verify WS client receives event on correct channel → terminate → verify lifecycle event
3. **Manual E2E:** `pnpm dev` → open browser → use `FlamecastProvider` + `useSession` → create session → verify events stream through multiplexed WS
4. **Backward compat:** Verify existing `useFlamecastSession` hook still works (connects directly to session-host WS, unaffected by new code)

Follow existing test patterns from `packages/flamecast/test/handle-session-event.test.ts` (mock runtime, `MemoryFlamecastStorage`, vitest).

---

## Deferred

- `POST /api/agents/:agentId/sessions` — requires session-host multi-session ACP support
- Channel wildcards (RFC open question #1)
- Per-channel rate limiting/backpressure (RFC open question #4)
- Persistent event history (survive server restarts)
