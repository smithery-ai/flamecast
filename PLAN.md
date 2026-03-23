# Flamecast: Stateless Control Plane + Sidecar Migration

## Context

Flamecast currently acts as a stateful intermediary — `LocalRuntimeClient` (~930 lines) holds live process handles, ACP connections, prompt queues, SSE subscribers, and writes every RPC to storage. This makes it impossible to deploy on serverless, adds latency, and couples log storage to the hot path.

**Goal**: Decouple into (1) a stateless control plane (session lifecycle + templates) and (2) a sidecar process (`runtime-bridge`) that bridges ACP stdio ↔ WebSocket for direct client ↔ agent communication. No auth. Functionality maintained at every step.

---

## Phase 1: Extract AcpBridge (pure refactor)

**PR**: `flamecast/phase-1-acp-bridge`

**What**: Pull the ACP bridging logic out of `LocalRuntimeClient` into a self-contained class. No new process boundary, no new protocol — just code organization.

**Files**:
- **Create** `packages/flamecast/src/runtime/acp-bridge.ts`
  - Class `AcpBridge` wrapping `acp.ClientSideConnection`
  - Takes `AcpTransport`, exposes: `initialize()`, `newSession()`, `prompt()`, `cancel()`
  - Contains the `createClient()` logic from `local.ts:706-912` (the `acp.Client` implementation: `sessionUpdate`, `requestPermission`, `readTextFile`, `writeTextFile`, terminal stubs, `extMethod`, `extNotification`)
  - Contains text chunk coalescing (`logSessionUpdateNotification` + `flushSessionTextChunkLogBuffer`)
  - Emits typed events via EventEmitter: `'rpc'`, `'sessionUpdate'`, `'permissionRequest'`, `'permissionResolved'`, `'turnStart'`, `'turnEnd'`, `'turnError'`, `'queueUpdated'`
  - Does NOT call storage — just emits events

- **Modify** `packages/flamecast/src/runtime/local.ts`
  - `ManagedSession.runtime.connection` → `ManagedSession.bridge: AcpBridge`
  - `startSession()` creates `AcpBridge` instead of raw `ClientSideConnection` + `createClient()`
  - Subscribes to bridge events → calls existing `pushLog`/`pushRpcLog`/`emitSessionEvent`
  - `promptSession()` delegates to `bridge.prompt()`
  - Delete `createClient()`, `logSessionUpdateNotification()`, `flushSessionTextChunkLogBuffer()` (moved to bridge)

- **Update tests**: Adjust `ManagedSession` type references in test helpers

**After this phase**: Identical user experience. All REST/SSE routes unchanged. Pure internal refactor.

---

## Phase 2: Add WebSocket server alongside SSE

**PR**: `flamecast/phase-2-ws-server`

**What**: Add a WS endpoint to the Hono server. Clients can connect via WS and receive the same events as SSE. Both protocols work simultaneously.

**Files**:
- **Create** `packages/flamecast/src/shared/ws-protocol.ts`
  - Message envelope: `{ id, type: "rpc"|"event"|"control", timestamp, payload }`
  - Server→client events: wraps `SessionLog` in envelope
  - Client→server control: `prompt`, `permission.respond`, `cancel`, `terminate`
  - Zod schemas for validation

- **Create** `packages/flamecast/src/runtime/ws-server.ts`
  - Uses Hono's built-in WebSocket upgrade (via `hono/ws` adapter) or `ws` package on raw Node server
  - Per-session WS connections managed via a `Map<sessionId, Set<WebSocket>>`
  - On connect: subscribes to `LocalRuntimeClient` events for that session, forwards as WS messages
  - On control message: delegates to `LocalRuntimeClient.promptSession()` / `resolvePermission()` / `terminateSession()`
  - Broadcasts to all connected clients for a session

- **Modify** `packages/flamecast/src/server/app.ts`
  - Add WS upgrade handling alongside existing `/api` routes

- **Modify** `packages/flamecast/src/shared/session.ts`
  - Add optional `websocketUrl?: string` to `SessionSchema`

- **Modify** `packages/flamecast/src/flamecast/api.ts`
  - `POST /agents` response includes `websocketUrl`
  - `GET /agents/:agentId` response includes `websocketUrl`

- **Add** `ws` dependency to `package.json` (if not using Hono's built-in WS)

**After this phase**: SSE still works. WS also works. `POST /agents` returns `websocketUrl`. Developers can connect via WS and interact. React UI still uses SSE.

---

## Phase 3: Client SDK + React hooks

**PR**: `flamecast/phase-3-client-sdk`

**What**: Build the typed `FlamecastSession` class and React hooks that connect via WebSocket.

**Files**:
- **Create** `packages/flamecast/src/client/lib/flamecast-session.ts`
  - Class `FlamecastSession`:
    - Constructor: `{ websocketUrl, sessionId }`
    - `connect()` / `disconnect()` — open/close WS
    - `on(event, handler)` — typed listeners (mirrors `SessionLog` types + namespaced events)
    - `off(event, handler)` — remove listener
    - `prompt(text)` — sends control message
    - `respondToPermission(requestId, body)` — sends control message
    - `cancel()` — sends control message
    - `terminate()` — sends control message
    - Auto-reconnect with exponential backoff (no token refresh needed)
    - In-memory event buffer for log/trace replay

- **Create** `packages/flamecast/src/client/hooks/use-flamecast-session.ts`
  - `useFlamecastSession(sessionId)` hook:
    - Fetches session metadata via REST to get `websocketUrl`
    - Creates/manages `FlamecastSession` lifecycle
    - Returns `{ session, events, prompt, respondToPermission, cancel, terminate, isConnected, connectionState }`
    - Accumulates events for the Markdown/Traces tabs

- **Create** `packages/flamecast/src/client/hooks/use-session-events.ts`
  - `useSessionEvents(session, eventType?)` — filtered event stream from a `FlamecastSession`

**After this phase**: SDK exists, hooks exist, but UI still uses SSE. Both paths coexist.

---

## Phase 4: Migrate React UI to WebSocket

**PR**: `flamecast/phase-4-ui-migration`

**What**: Swap the session detail page from SSE+REST to the WS-based hooks. SSE endpoint remains but has no consumers.

**Files**:
- **Modify** `packages/flamecast/src/client/routes/sessions.$id.tsx`
  - Replace `useEffect(() => subscribeToSessionEvents(...))` with `useFlamecastSession(id)`
  - Replace `sendPrompt(id, text)` with `session.prompt(text)`
  - Replace `respondToPermission(id, requestId, body)` with `session.respondToPermission(requestId, body)`
  - Markdown tab: derive segments from WS event buffer instead of REST `logs[]`
  - Traces tab: same — from WS event buffer
  - Files tab: keep REST `fetchSession()` for initial FS snapshot, WS for incremental `filesystem.changed`/`filesystem.snapshot` events
  - Permission card: driven by WS events
  - Keep REST `fetchFilePreview()` for file preview panel

- **Modify** `packages/flamecast/src/client/lib/api.ts`
  - Mark `subscribeToSessionEvents()` as deprecated (don't delete yet)

**After this phase**: UI is fully on WebSocket. SSE endpoint is dead code. REST still used for: session create/list/terminate, initial hydration, file preview, templates.

---

## Phase 5: Sidecar as separate process

**PR**: `flamecast/phase-5-sidecar`

**What**: Move `AcpBridge` + WS server + file watcher into a standalone process that the runtime provider spawns. The control plane no longer holds ACP connections.

**Files**:
- **Create** `packages/runtime-bridge/` (new package)
  - `package.json` — `@acp/runtime-bridge`, bin: `runtime-bridge`
  - `src/index.ts` — entry point:
    - Reads config from env: `BRIDGE_PORT`, `BRIDGE_WORKSPACE`, agent command/args
    - Spawns agent process via `child_process.spawn`
    - Creates `AcpBridge` from agent stdio
    - Starts WS server on `BRIDGE_PORT` (or random port)
    - Starts file watcher on workspace
    - Prints `{"ready": true, "port": N, "websocketUrl": "ws://..."}` to stdout
  - `src/acp-bridge.ts` — moved from flamecast (or imported if shared)
  - `src/ws-server.ts` — standalone WS server (no Hono dependency)
  - `src/file-watcher.ts` — moved from `createFileSystemEventStream()` in `runtime-provider.ts`

- **Modify** `packages/flamecast/src/flamecast/runtime-provider.ts`
  - `StartedRuntime` gains `websocketUrl: string`
  - `localProvisioner` now:
    1. Spawns `runtime-bridge` process (not the agent directly)
    2. Waits for `{"ready": true, "port": N}` on stdout
    3. Returns `{ websocketUrl, terminate: () => kill(bridgePid) }`
    4. No longer returns `transport` (the sidecar owns it)

- **Modify** `packages/flamecast/src/runtime/local.ts`
  - `startSession()` no longer creates `AcpBridge` in-process
  - Stores `websocketUrl` from provider result
  - Creates an internal `FlamecastSession` (client SDK) to subscribe to the sidecar — forwards events to any remaining SSE subscribers (backward compat shim)
  - `promptSession()` / `resolvePermission()` delegate to the internal `FlamecastSession`

- **Modify** `packages/flamecast/src/flamecast/index.ts`
  - `createSession()` returns the sidecar's `websocketUrl`

**After this phase**: Agent runs in a sidecar process. React UI connects directly to sidecar WS. Control plane connects to sidecar as a WS client only to proxy events for any remaining SSE consumers. This is the key architectural shift.

---

## Phase 6: Remove SSE, slim storage, clean up

**PR**: `flamecast/phase-6-cleanup`

**What**: Delete the SSE endpoint, stop storing RPC logs, slim the control plane to a pure session registry.

**Files**:
- **Modify** `packages/flamecast/src/flamecast/api.ts`
  - Delete `GET /agents/:agentId/events` (SSE endpoint)
  - Delete `POST /agents/:agentId/prompt` (now via WS)
  - Delete `POST /agents/:agentId/permissions/:requestId` (now via WS)
  - Delete `GET /agents/:agentId/queue` and `DELETE /agents/:agentId/queue/:queueId` (now via WS)
  - Keep: health, templates, session CRUD, file preview

- **Modify** `packages/flamecast/src/runtime/local.ts`
  - Remove `sseSubscribers` map
  - Remove `subscribe()` method
  - Remove `pushLog()` / `pushRpcLog()` calls
  - Remove internal `FlamecastSession` proxy shim from Phase 5
  - `RuntimeClient` interface slims to: `startSession`, `terminateSession`, `hasSession`, `listSessionIds`, `getFileSystemSnapshot`, `getFilePreview`

- **Modify** `packages/flamecast/src/runtime/client.ts`
  - Remove `promptSession`, `resolvePermission`, `getQueueState`, `cancelQueuedPrompt`, `subscribe` from interface

- **Modify** `packages/flamecast/src/flamecast/storage.ts`
  - `appendLog()` and `getLogs()` become no-ops or are removed
  - `Session` type drops `logs` array

- **Modify** `packages/flamecast/src/client/lib/api.ts`
  - Delete `subscribeToSessionEvents()`, `sendPrompt()`, `respondToPermission()`
  - Keep REST functions: `fetchSessions`, `fetchSession`, `createSession`, `terminateSession`, `fetchAgentTemplates`, `registerAgentTemplate`, `fetchFilePreview`

- **Modify** storage schema: `sessionLogs` table can be dropped (migration)

**After this phase**: Control plane is stateless. All real-time interaction flows through sidecar WS. REST API surface is ~8 endpoints (health, templates CRUD, sessions CRUD, file preview). This is the target architecture.

---

## Phase 7 (stretch): Move file preview to sidecar

**PR**: `flamecast/phase-7-file-ops`

- Sidecar handles `{ type: "file.preview", path }` control messages
- Client SDK gains `getFilePreview(path)` method
- Remove `GET /agents/:agentId/file` from control plane
- Control plane becomes a pure session registry with zero agent interaction

---

## Phase Summary

| Phase | What Ships | SSE | WS | Sidecar Process | Log Storage | Breaking |
|-------|-----------|-----|-----|-----------------|-------------|----------|
| 1 | AcpBridge extraction | Yes | No | No (in-process) | Yes | No |
| 2 | WS server alongside SSE | Yes | Yes | No (in-process) | Yes | No |
| 3 | Client SDK | Yes | Yes | No | Yes | No |
| 4 | UI migrates to WS | Yes (unused) | Yes (primary) | No | Yes | No |
| 5 | Sidecar as separate process | Yes (proxy) | Yes | Yes | Metadata only | No |
| 6 | Remove SSE + log storage | No | Yes | Yes | Metadata only | Yes (REST) |
| 7 | File ops in sidecar | No | Yes | Yes | Metadata only | Yes (REST) |

---

## Key Reusable Code

| What | Current location | Reuse in |
|------|-----------------|----------|
| ACP `createClient()` impl | `local.ts:706-912` | `acp-bridge.ts` |
| Text chunk coalescing | `local.ts:527-627` | `acp-bridge.ts` |
| `createFileSystemEventStream()` | `runtime-provider.ts:336-383` | `runtime-bridge/file-watcher.ts` |
| `buildFileSystemSnapshot()` | `runtime-provider.ts:287-334` | `runtime-bridge/file-watcher.ts` |
| `openLocalTransport()` | `transport.ts:41-55` | `runtime-bridge/index.ts` |
| `findFreePort()` | `transport.ts:123-133` | `runtime-bridge/index.ts` |
| `sessionLogsToSegments()` | `client/lib/logs-markdown.ts` | Unchanged (works with WS event buffer) |
| Prompt queue logic | `local.ts:223-303` | Moves to sidecar in Phase 5 |

---

## Verification

After each phase, verify:
1. `pnpm build` passes
2. Existing tests pass (with updates)
3. Manual test: start flamecast, create session from template, send prompt, see streaming response, approve permission, see file changes, terminate session
4. After Phase 2+: verify WS connection works via browser devtools or wscat
5. After Phase 4+: verify the React UI renders correctly with WS-sourced events
6. After Phase 5+: verify `ps aux` shows separate sidecar + agent processes
7. After Phase 6: verify no SSE endpoint exists, no RPC logs written to storage
