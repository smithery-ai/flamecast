# SMI-1704: Multi-Session WebSocket Adapter with Channel Subscriptions

## Context

Today each session requires its own WebSocket connection directly to its session-host process (1:1 model). The control plane (`Flamecast` class + Hono API) is HTTP-only. Session-hosts POST callback events to `/api/agents/:id/events`, but the control plane has no way to push real-time events to browser clients.

This doesn't scale for tabbed editors (10 sessions = 10 connections), dashboards monitoring all agents, or UIs that need filtered event streams. The RFC at `apps/docs/rfcs/multi-session-websocket.mdx` specifies the target architecture.

**Goal:** Add a server-side WS multiplexer on the control plane with channel-based subscriptions, composed React hooks sharing a single connection, and backward compatibility with the existing per-session WS model.

---

## Architecture (revised after review)

```
Browser (single WS) ──ws──> ws://localhost:3001/ws
                              │
                         WsAdapter (new)
                         ┌──────────────────────────────────┐
                         │  channelToClients map             │
                         │  subscribe / unsubscribe          │
                         │  routeEvent()                     │
                         │                                   │
                         │  SessionHostBridge (new)          │
                         │  Map<sessionId, WebSocket>        │
                         │  ─ opens read-only WS to each     │
                         │    active session-host             │
                         │  ─ receives ALL events             │
                         │                                   │
                         │  EventBus (lifecycle only)         │
                         │  ─ session.created / terminated    │
                         │  ─ triggers bridge connect/close   │
                         └──────────────────────────────────┘
                              ↕ WS (events)     ↕ HTTP (commands)
                         session-host-1      session-host-2
```

### Why WS proxy, not callback fan-out

The original plan proposed callback fan-out: session-hosts already POST events to the control plane, so emit from `handleSessionEvent()` to an EventBus. **This doesn't work.** Analysis of the session-host code reveals:

**Via callbacks, the multiplexer receives:** `permission_request`, `session_end`, `end_turn`, `error`
**Via callbacks, the multiplexer MISSES:** All `rpc` events (`session.update`, tool calls, assistant message tokens), `filesystem.changed`, `permission_approved/rejected`, `session.terminated`

The `agent_message` callback was explicitly disabled as "too chatty" (one per chunk). HTTP POST per streaming token is not viable. This means a callback-only multiplexer can't render a conversation — it misses the core streaming events.

**Resolution:** The WsAdapter opens a **read-only WS connection** to each active session-host (using `websocketUrl` from `SessionService`). This gives full event fidelity — the adapter sees everything a direct client sees. Commands from browser clients still proxy via HTTP (`SessionService.proxyRequest()`).

The EventBus remains but only for **lifecycle events** (`session.created`, `session.terminated`) that originate in the control plane — not for session event routing.

---

## Build Order

### Step 1: Protocol types

### Step 2: EventBus (lifecycle) + ChannelRouter (pure logic, unit-testable)

### Step 3: SessionHostBridge + WsAdapter + Flamecast integration

### Step 4: Client-side FlamecastConnection + FlamecastProvider + hooks

Steps 1-3 form **PR 1** (server infra). Step 4 is **PR 2** (client hooks).

Deferred to follow-up tickets:

- `POST /api/agents/:agentId/sessions` (requires session-host multi-ACP support)
- `session.create` WS action (depends on the above REST endpoint)

---

## Step 1: Protocol Types

### NEW `packages/protocol/src/ws-channels.ts`

Channel-based WS message types, separate from existing `ws.ts` (backward compat).

**Client-to-Server actions:**

- `subscribe` / `unsubscribe` — `{ action, channel, since?: number }` (`since` is optional sequence number for replay-from-point on reconnect)
- `prompt` — `{ action, sessionId, text }`
- `permission.respond` — `{ action, sessionId, requestId, body }`
- `cancel` — `{ action, sessionId, queueId? }`
- `terminate` — `{ action, sessionId }`
- `ping`

**Queue actions (forwarded from PR #77):** `queue.reorder`, `queue.clear`, `queue.pause`, `queue.resume` — these already exist in `packages/protocol/src/ws.ts` as `WsQueueReorderAction`, `WsQueueClearAction`, `WsQueuePauseAction`, `WsQueueResumeAction`. The channel adapter must forward them to session-hosts via HTTP proxy, not defer them.

**Not included (deferred):** `session.create`, `terminal.input`, `terminal.resize` — these depend on multi-session or features not yet implemented. Adding dead protocol types creates confusion.

**Server-to-Client messages:**

- `connected` — `{ type, connectionId }`
- `subscribed` / `unsubscribed` — `{ type, channel }`
- `event` — `{ type, channel, sessionId, agentId?, seq, event: { type, data, timestamp } }` — `seq` is a per-session monotonic sequence number for client-side dedup
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

Typed wrapper around `node:events` EventEmitter. **Scoped to lifecycle events only** — session event routing comes from the SessionHostBridge WS connections, not from callbacks.

```ts
interface ChannelEvent {
  sessionId: string;
  agentId: string; // = sessionId until multi-session lands (see "agentId sourcing" below)
  seq: number;
  event: { type: string; data: Record<string, unknown>; timestamp: string };
}
```

- `emit("session.created", { sessionId, agentId, websocketUrl })` — triggers bridge connect
- `emit("session.terminated", { sessionId, agentId })` — triggers bridge disconnect
- `on(eventName, listener)` — returns unsubscribe function
- **History ring buffer:** `Map<sessionId, ChannelEvent[]>`, with **per-category caps** (day-one, not deferred — streaming sessions can produce hundreds of RPC events per turn):
  - Default: 1000 events
  - Terminal events: 5000 (high-frequency output)
  - RPC/conversation events: 2000 (streaming tokens)
  - Queue/FS events: 100 (low-frequency snapshots)
  - Caps configurable via `EventBusOptions`
- `getHistory(sessionId, filter?)` — for replay on subscribe
- `clearHistory(sessionId)` — called on session termination. No delayed cleanup — once terminated, new subscribers get empty history. Late subscribers of terminated sessions get the `session.terminated` lifecycle event only.
- **Per-session sequence counter:** Monotonic `seq` number assigned to each event. Used for `since`-based replay and client-side dedup on reconnect.

### NEW `packages/flamecast/src/flamecast/channel-router.ts`

Pure function: `eventToChannels(event: ChannelEvent): string[]`

Maps an event to all channel strings it belongs to using an **explicit allowlist**, not string-matching heuristics:

```ts
const TERMINAL_EVENT_TYPES = new Set([
  "terminal.create",
  "terminal.output",
  "terminal.release",
  "terminal.wait_for_exit",
  "terminal.kill",
]);

const QUEUE_EVENT_TYPES = new Set(["queue.updated", "queue.paused", "queue.resumed"]);

const FS_EVENT_TYPES = new Set(["filesystem.changed", "filesystem.snapshot", "file.preview"]);
```

For `rpc` events, check `event.data.method` against the allowlist sets. For non-rpc events, check `event.type` directly.

Routing rules:

- Every event belongs to `session:{sessionId}`
- Terminal events also to `session:{id}:terminal` (and `session:{id}:terminal:{terminalId}` if present)
- Queue events also to `session:{id}:queue`
- FS events also to `session:{id}:fs` and `agent:{agentId}:fs`
- All events also to `agent:{agentId}`
- Lifecycle events also to `agents`

Unknown event types default to `session:{id}` + `agent:{agentId}` only (no sub-channel). New event types require explicit mapping.

---

## Step 3: SessionHostBridge + WsAdapter + Flamecast Integration

### NEW `packages/flamecast/src/flamecast/session-host-bridge.ts`

Manages WS connections from the control plane to each active session-host.

```ts
class SessionHostBridge {
  private connections: Map<sessionId, WebSocket>;
  private readonly onEvent: (sessionId: string, event: ChannelEvent) => void;

  /** Open a read-only WS connection to a session-host. Called on session.created. */
  connect(sessionId: string, websocketUrl: string): void;

  /** Close the connection. Called on session.terminated. */
  disconnect(sessionId: string): void;

  /** Close all connections. Called on Flamecast.shutdown(). */
  disconnectAll(): void;
}
```

On connect:

1. Open `new WebSocket(websocketUrl)` (using `ws` package)
2. On message: parse the session-host's `WsServerMessage`, convert to `ChannelEvent` (assign `seq`, `agentId`), call `onEvent` callback
3. On close/error: log warning, attempt reconnect with exponential backoff. **Give up after max retries (default 5) or if the session has been terminated** (bridge listens for `session.terminated` lifecycle event and stops retrying). Without this cap, a permanently dead session-host causes infinite retries.
4. Ignore the `connected` handshake message from the session-host

The bridge is **read-only** — it never sends messages to session-hosts through these connections. Commands from browser clients are proxied via HTTP.

### NEW `packages/flamecast/src/flamecast/ws-adapter.ts`

Core server-side component. Receives events from both the SessionHostBridge (all session events) and the EventBus (lifecycle events).

**Data structures:**

```ts
interface ClientConnection {
  id: string; // connectionId (UUID)
  ws: WebSocket;
  subscriptions: Set<string>;
}

class WsAdapter {
  clients: Map<string, ClientConnection>;
  channelToClients: Map<string, Set<string>>; // reverse index
  bridge: SessionHostBridge;
  eventBus: EventBus;
}
```

**WS attachment strategy:**

`@hono/node-server`'s `serve()` returns `ServerType` which is `http.Server` (verified for v1.19.11). Create `WebSocketServer({ noServer: true })` and listen for `upgrade` events:

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
3. On close: remove client from all channel sets, decrement ref counts

**Subscribe flow:**

1. Check `maxSubscriptionsPerConnection` (100). Skip check if `channel` is already in `client.subscriptions` (idempotent re-subscribe on reconnect).
2. Add client to `channelToClients` reverse index FIRST
3. Replay history from EventBus ring buffer, filtered by channel. If `since` seq number provided, replay only events with `seq > since`.
4. Send `{ type: "subscribed", channel }`

**Event routing (`routeEvent`):**

1. Call `eventToChannels(event)` to get all matching channel strings
2. Iterate channels, look up `channelToClients` for each
3. **Deduplication:** Track `Set<connectionId>` per event — each client gets the event at most once, tagged with the most specific matching channel. **Specificity ordering** (most specific first): sub-channel with ID (`session:X:terminal:T`) > sub-channel (`session:X:terminal`) > session (`session:X`) > agent (`agent:Y`) > global (`agents`). Implementation: `eventToChannels()` returns channels in specificity order (most specific first). For each client, use the first channel from the ordered list that the client is subscribed to.

**History replay strategy:**

- `session:{id}` — replay events where `seq > since` (or full buffer if no `since`)
- `session:{id}:terminal` — replay only terminal-classified events
- `session:{id}:queue` — replay only latest queue state event (point-in-time snapshot, not history)
- `session:{id}:fs` — replay only latest `filesystem.changed`/`filesystem.snapshot` event

**Command proxying (upstream) — uses existing Flamecast methods from PRs #76/#77:**

- `prompt` → `flamecast.promptSession(sessionId, text)`
- `terminate` → `flamecast.terminateSession(sessionId)`
- `permission.respond` → `flamecast.resolvePermission(sessionId, requestId, body)` (PR #76 — proxies to session-host `POST /permissions/:requestId`)
- `queue.reorder` → `flamecast.proxyQueueRequest(sessionId, "/queue/reorder", { method: "PUT", body })` (PR #77)
- `queue.clear` → `flamecast.proxyQueueRequest(sessionId, "/queue", { method: "DELETE" })`
- `queue.pause` → `flamecast.proxyQueueRequest(sessionId, "/queue/pause", { method: "POST" })`
- `queue.resume` → `flamecast.proxyQueueRequest(sessionId, "/queue/resume", { method: "POST" })`

### MODIFY `packages/flamecast/src/flamecast/index.ts`

1. Add `EventBus` as private member, created in constructor
2. In `createSession()` — after session starts, emit `eventBus.emit("session.created", { sessionId, agentId: resolveAgentId(sessionId), websocketUrl })`.
3. In `terminateSession()` — emit `eventBus.emit("session.terminated", { sessionId, agentId: resolveAgentId(sessionId) })`
4. In `handleSessionEvent()` — continue dispatching to handlers + webhook delivery as before. Do NOT emit to EventBus here (events come from the bridge now, not callbacks). The callback path remains for handler dispatch and webhook delivery only.
5. Add `attachWebSocket(server: ServerType): WsAdapter` public method — creates SessionHostBridge + WsAdapter, wires EventBus lifecycle events to bridge connect/disconnect. The WsAdapter receives the `Flamecast` instance (typed as `FlamecastApi`) so it can call `promptSession()`, `resolvePermission()`, `proxyQueueRequest()`, `terminateSession()` for command proxying. No changes to `FlamecastApi` type needed — it already includes all required methods (expanded in PRs #76/#77).
6. Add bridge/adapter cleanup to `shutdown()`

### MODIFY `apps/server/src/index.ts`

Capture `serve()` return value, call `attachWebSocket()`:

```ts
const server = serve({ fetch: flamecast.app.fetch, port: 3001 }, (info) => { ... });
flamecast.attachWebSocket(server);
```

### MODIFY `packages/flamecast/package.json`

Add dependency: `"ws": "^8.18.0"`, devDep: `"@types/ws": "^8.18.1"`

**Bundle isolation:** `ws-adapter.ts`, `session-host-bridge.ts`, and `event-bus.ts` are in `src/flamecast/` (server-side). The client barrel at `src/client/index.ts` must NOT re-export from `src/flamecast/`. The server barrel at `src/server/index.ts` (or top-level `src/index.ts`) exports server code. This split already exists — the plan relies on maintaining it. If `packages/flamecast/src/index.ts` re-exports everything, add a separate `src/server.ts` entry point that exports the WS adapter, and ensure the client entry point does not import from it.

---

## Step 4: Client-Side SDK

The client SDK has two layers: a **framework-agnostic core** (works in any JS/TS environment) and **React hooks** (thin layer on top). Both consume the same underlying primitive: `ChannelSubscription`.

### Final SDK Shape

**`@flamecast/sdk/client`** — Framework-agnostic core:

```ts
// REST client (existing, unchanged)
createFlamecastClient({ baseUrl }) → FlamecastClient

// Multiplexed WS (new)
FlamecastConnection              // shared WS connection manager
ChannelSubscription              // AsyncIterable<ChannelEvent> primitive

// Legacy per-session WS (existing, backward compat)
FlamecastSession
```

**`@flamecast/sdk/client/hooks`** — React hooks:

```ts
FlamecastProvider; // shared WS context
useFlamecast(); // connection state
useSession(sessionId); // conversation events + actions
useTerminal(sessionId); // terminal state
useQueue(sessionId); // queue state (supersedes PR #77)
useFileSystem(target); // filesystem state
useAgent(agentId); // agent-level aggregation
useFlamecastSession(sessionId); // legacy per-session hook (backward compat)
```

### NEW `packages/flamecast/src/client/lib/channel-subscription.ts`

The core primitive. Implements `AsyncIterable<ChannelEvent>` so consumers can use `for await...of`:

```ts
class ChannelSubscription implements AsyncIterable<ChannelEvent> {
  readonly channel: string;

  // AsyncIterable — for non-React consumers
  [Symbol.asyncIterator](): AsyncIterator<ChannelEvent>;

  // Callback-style — for React hooks (used with useSyncExternalStore)
  onEvent(cb: (event: ChannelEvent) => void): () => void;

  // Unsubscribe from the channel and close the iterator
  return(): void;
}
```

**Implementation:** Internal push/pull queue. When an event arrives and a consumer is awaiting `next()`, resolve immediately. Otherwise, buffer the event. `return()` sends WS `unsubscribe`, closes the iterator, and cleans up.

**Usage — Node.js / vanilla JS:**

```ts
const conn = new FlamecastConnection({ url: "ws://localhost:3001/ws" });
conn.connect();

const events = conn.subscribe(`session:${sessionId}`);

for await (const event of events) {
  console.log(event.event.type, event.event.data);
  if (event.event.type === "session.terminated") break;
}
// Iterator closed, channel unsubscribed
```

**Usage — filtered channels:**

```ts
// Only terminal output
for await (const event of conn.subscribe(`session:${id}:terminal`)) {
  process.stdout.write(event.event.data.output as string);
}

// Only filesystem changes across an agent
for await (const event of conn.subscribe(`agent:${agentId}:fs`)) {
  console.log("file changed:", event.event.data);
}
```

React hooks use `onEvent()` internally (not the async iterator), because `useSyncExternalStore` needs synchronous callback-based subscriptions.

### NEW `packages/flamecast/src/client/lib/flamecast-connection.ts`

Shared WS connection manager. Owns the single WebSocket and creates `ChannelSubscription` instances:

```ts
class FlamecastConnection {
  constructor(opts: { url: string; maxReconnectAttempts?: number });

  // Lifecycle
  connect(): void;
  disconnect(): void;
  get connectionState(): ConnectionState;
  onStateChange(cb: (state: ConnectionState) => void): () => void;

  // Channel subscriptions — returns AsyncIterable
  subscribe(channel: string, opts?: { since?: number }): ChannelSubscription;

  // Commands (convenience methods over sendAction)
  prompt(sessionId: string, text: string): void;
  respondToPermission(sessionId: string, requestId: string, body: PermissionResponseBody): void;
  cancel(sessionId: string, queueId?: string): void;
  terminate(sessionId: string): void;
}
```

- Ref-counted subscriptions internally: first `subscribe("session:X")` sends WS subscribe message, last `ChannelSubscription.return()` sends WS unsubscribe
- Auto-reconnect with exponential backoff (same pattern as existing `FlamecastSession`)
- **Reconnection with `since`:** Tracks the last `seq` received per channel. On reconnect, re-sends all active subscriptions with `since: lastSeq` so the server replays only missed events, not the full history. This avoids client-side dedup complexity.
- Connection states: `disconnected | connecting | connected | reconnecting`

### NEW `packages/flamecast/src/client/lib/flamecast-context.ts`

React Context holding `FlamecastConnection`. `useFlamecastContext()` throws if not in provider.

### NEW `packages/flamecast/src/client/components/flamecast-provider.tsx`

```tsx
<FlamecastProvider url="ws://localhost:3001/ws">{children}</FlamecastProvider>
```

Creates `FlamecastConnection` in a ref, connects on mount, disconnects on unmount.

### NEW `packages/flamecast/src/client/hooks/use-flamecast.ts`

Exposes `connection`, `connectionState`, `isConnected` via `useSyncExternalStore`.

### NEW `packages/flamecast/src/client/hooks/use-session.ts`

Subscribes to `session:{sessionId}`. Returns `{ events, prompt, respondToPermission, cancel, terminate }`.

**`useSyncExternalStore` snapshot pattern:** Creates a `ChannelSubscription` and uses its `onEvent()` callback (not the async iterator). Events are accumulated in a ref. On each new event, a **new array** is created (`eventsRef.current = [...eventsRef.current, log]`). `getSnapshot()` returns `eventsRef.current` (stable reference between updates). Because a new array reference is assigned on each event, React detects the change. Between events, `getSnapshot` returns the same reference, so React skips re-render.

### NEW `packages/flamecast/src/client/hooks/use-terminal.ts`

Subscribes to `session:{sessionId}:terminal`. Returns `{ terminals, activeTerminal, sendInput, resize }`.

### MODIFY `packages/flamecast/src/client/hooks/use-queue.ts`

**Collision with PR #77:** This file exists on main since PR #77. Current signature: `useQueue(session: FlamecastSession | null)` — takes a `FlamecastSession` instance and subscribes to `queue.updated`, `queue.paused`, `queue.resumed` events directly on the session-host WS.

This PR **supersedes** it: change the signature to `useQueue(sessionId: string)` and subscribe via `FlamecastConnection` to the `session:{id}:queue` channel. The hook's return API stays the same (`{ items, processing, paused, size, cancel, clear, reorder, pause, resume }`), but the transport changes from direct session-host WS to the multiplexed adapter. Queue commands (`clear`, `reorder`, `pause`, `resume`) use `connection.sendAction()` instead of `session.clearQueue()` / `session.reorderQueue()` / etc.

The old `FlamecastSession` queue methods (`clearQueue()`, `reorderQueue()`, `pauseQueue()`, `resumeQueue()`) remain available for backward-compat callers using `useFlamecastSession` directly.

### NEW `packages/flamecast/src/client/hooks/use-file-system.ts`

Accepts `sessionId: string` or `{ agentId: string }` via discriminated union. Subscribes to `session:{id}:fs` or `agent:{id}:fs`. Returns `{ files, requestPreview }`.

### NEW `packages/flamecast/src/client/hooks/use-agent.ts`

Subscribes to `agent:{agentId}`. Returns `{ sessions: Map<id, SessionState>, prompt, respondToPermission, terminate }`.

**Note:** `createSession` method is NOT included in this hook until the `session.create` WS action and `POST /api/agents/:agentId/sessions` REST endpoint are implemented.

### UNCHANGED (backward compat)

- `packages/flamecast/src/client/hooks/use-flamecast-session.ts` — existing per-session hook, untouched
- `packages/flamecast/src/client/lib/flamecast-session.ts` — existing per-session WS client, untouched
- `packages/protocol/src/ws.ts` — existing message types, untouched

---

## Files Summary

| File                                                              | Action                    | Step |
| ----------------------------------------------------------------- | ------------------------- | ---- |
| `packages/protocol/src/ws-channels.ts`                            | NEW                       | 1    |
| `packages/protocol/src/index.ts`                                  | MODIFY                    | 1    |
| `packages/protocol/package.json`                                  | MODIFY                    | 1    |
| `packages/flamecast/src/flamecast/event-bus.ts`                   | NEW                       | 2    |
| `packages/flamecast/src/flamecast/channel-router.ts`              | NEW                       | 2    |
| `packages/flamecast/src/flamecast/session-host-bridge.ts`         | NEW                       | 3    |
| `packages/flamecast/src/flamecast/ws-adapter.ts`                  | NEW                       | 3    |
| `packages/flamecast/src/flamecast/index.ts`                       | MODIFY                    | 3    |
| `packages/flamecast/package.json`                                 | MODIFY                    | 3    |
| `apps/server/src/index.ts`                                        | MODIFY                    | 3    |
| `packages/flamecast/src/client/lib/channel-subscription.ts`       | NEW                       | 4    |
| `packages/flamecast/src/client/lib/flamecast-connection.ts`       | NEW                       | 4    |
| `packages/flamecast/src/client/lib/flamecast-context.ts`          | NEW                       | 4    |
| `packages/flamecast/src/client/components/flamecast-provider.tsx` | NEW                       | 4    |
| `packages/flamecast/src/client/hooks/use-flamecast.ts`            | NEW                       | 4    |
| `packages/flamecast/src/client/hooks/use-session.ts`              | NEW                       | 4    |
| `packages/flamecast/src/client/hooks/use-terminal.ts`             | NEW                       | 4    |
| `packages/flamecast/src/client/hooks/use-queue.ts`                | MODIFY (supersede PR #77) | 4    |
| `packages/flamecast/src/client/hooks/use-file-system.ts`          | NEW                       | 4    |
| `packages/flamecast/src/client/hooks/use-agent.ts`                | NEW                       | 4    |
| `packages/flamecast/test/event-bus.test.ts`                       | NEW                       | 2    |
| `packages/flamecast/test/channel-router.test.ts`                  | NEW                       | 2    |
| `packages/flamecast/test/session-host-bridge.test.ts`             | NEW                       | 3    |
| `packages/flamecast/test/ws-adapter.test.ts`                      | NEW                       | 3    |
| `packages/flamecast/test/ws-integration.test.ts`                  | NEW                       | 3    |

---

## Key Design Decisions

1. **WS proxy (not callback fan-out):** The control plane opens read-only WS connections to each active session-host. This gives full event fidelity — RPC events, filesystem changes, permission confirmations all flow through. Commands from browser clients still proxy via HTTP (`SessionService.proxyRequest`). The EventBus is scoped to lifecycle events only.

2. **Sequence-based reconnection:** Each event gets a per-session monotonic `seq` number. `FlamecastConnection` tracks last `seq` per channel. On reconnect, subscribes with `since: lastSeq`. Server replays only events with `seq > since`. No client-side dedup needed, no full-history re-processing on reconnect.

3. **In-memory history:** Ring buffer per session, capped at configurable max (default 1000). Cleared immediately on session termination — no delayed cleanup, no race with late subscribers.

4. **Event deduplication:** If a client subscribes to both `agent:X` and `session:Y`, each event delivered once, tagged with the most specific matching channel.

5. **agentId sourcing:** Centralized in a single `resolveAgentId(sessionId: string): string` function (in `channel-router.ts` or a shared util). Returns `sessionId` in the 1:1 model. All emit sites (`createSession`, `terminateSession`, `SessionHostBridge.onEvent`) call this function instead of scattering `agentId: sessionId` inline. When multi-session lands, only this function changes.

6. **Channel classification via allowlist:** Event type → channel mapping uses explicit `Set<string>` lookups, not string-matching heuristics. Unknown event types route to `session:{id}` + `agent:{id}` only. New event types require adding to the allowlist.

7. **`ws` bundle isolation:** `ws-adapter.ts`, `session-host-bridge.ts`, `event-bus.ts` are in `src/flamecast/` (server-side). Client barrel `src/client/index.ts` must not import from `src/flamecast/` server modules. If the top-level barrel re-exports everything, add a separate server entry point.

8. **`useSyncExternalStore` snapshot stabilization:** Hooks create a new array reference on each event (`eventsRef.current = [...prev, newEvent]`). `getSnapshot()` returns `eventsRef.current` directly (stable between updates). React sees new reference only when data changes.

9. **`useFileSystem` overload:** Uses discriminated union `string | { agentId: string }` rather than TypeScript function overloads to avoid resolution ambiguity.

10. **Deferred protocol types:** `session.create`, `terminal.input`, `terminal.resize` are NOT included in the channel protocol types. They depend on features that don't exist yet. Queue actions (`queue.reorder/clear/pause/resume`) ARE included — they already exist in `ws.ts` from PR #77 and have backing implementations.

---

## Verification

1. **Unit tests:**
   - `event-bus.test.ts`: emit/receive lifecycle events, history storage/retrieval, cap enforcement, seq numbering, `since`-filtered replay, clearHistory
   - `channel-router.test.ts`: allowlist-based classification for rpc/terminal/queue/fs events, unknown event fallback, agentId propagation
   - `session-host-bridge.test.ts`: connect/disconnect lifecycle, event parsing from session-host WS format, reconnect on connection loss
   - `ws-adapter.test.ts`: subscribe/unsubscribe, routing, dedup, `since`-based history replay, max subscriptions (with idempotent re-subscribe bypass), command proxying

2. **Integration test** (`ws-integration.test.ts`):
   Create Flamecast with mock runtime → `attachWebSocket(server)` → create session via REST → connect WS client to `/ws` → subscribe to `session:{id}` → simulate session-host WS events via a mock WS server (standing in for the session-host) → verify browser WS client receives events on correct channel with correct `seq` → terminate → verify lifecycle event → verify history cleared

3. **Manual E2E:** `pnpm dev` → open browser → use `FlamecastProvider` + `useSession` → create session → verify events stream through multiplexed WS → verify backward compat: `useFlamecastSession` still works (connects directly to session-host WS)

Follow existing test patterns from `packages/flamecast/test/handle-session-event.test.ts` (mock runtime, `MemoryFlamecastStorage`, vitest).

---

## Deferred

- `POST /api/agents/:agentId/sessions` — requires session-host multi-ACP support
- `session.create` WS action — depends on the above REST endpoint
- `terminal.input`, `terminal.resize` WS actions — depends on terminal session implementation (SMI-1683)
- Channel wildcards (RFC open question #1)
- Per-channel rate limiting/backpressure (RFC open question #4)
- Persistent event history (survive server restarts)
