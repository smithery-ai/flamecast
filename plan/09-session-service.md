# 2.4 — SessionService

**Goal:** Replace `SessionManager` with `SessionService` — named runtime dispatch, event handler invocation, cleaner interface.

**Depends on:** 2.1 (Runtime interface + event handler types)

## What to do

Create `packages/flamecast/src/flamecast/session-service.ts`. See `implementation_plan_v2.md` §3.3 for the full implementation.

Key differences from `SessionManager`:

- Constructor takes `Record<string, Runtime>` instead of a single `DataPlaneBinding`
- `createSession()` looks up runtime by `opts.runtime.provider` name
- Tracks `runtimeName` per session for correct dispatch on terminate
- Accepts event handlers (passed from Flamecast constructor) and invokes them on lifecycle events

In-memory Map is the source of truth for active session handles. No durable recovery in MVP.

Delete `packages/flamecast/src/flamecast/session-manager.ts`.

## SessionHost start response change

The `SessionHostStartResponse` now returns `hostUrl` instead of `port`:

```typescript
const result = (await response.json()) as { hostUrl: string; websocketUrl: string };
```

`LocalRuntime` constructs `hostUrl` from `localhost:PORT` before returning the response. Remote runtimes return their platform-specific URL.

## Files

- **New:** `packages/flamecast/src/flamecast/session-service.ts`
- **Delete:** `packages/flamecast/src/flamecast/session-manager.ts`
- **Update:** any imports referencing `SessionManager` or `session-manager.ts`

## Test Coverage

Integration tests (use real `LocalRuntime` instances, real child processes):

- **Runtime dispatch:** Register two runtimes (`local`, `other`). Create a session with each provider. Verify the correct runtime receives the `fetchSession` call.
- **Unknown provider:** `createSession` with an unregistered provider. Verify error message lists available providers (e.g., `"Unknown provider 'foo'. Available: local, other"`).
- **Terminate dispatch:** Create session with runtime A. Terminate it. Verify runtime A (not B) receives the terminate request.
- **Event handler invocation:** Register `onPermissionRequest` handler. Create session. Trigger a permission request. Verify handler called with correct `SessionContext` (matching `id`, `agentName`, `runtime`).
- **Server-side permission resolution:** `onPermissionRequest` returns `{ optionId: "allow" }`. Verify permission is resolved server-side without flowing to WS. Tool execution completes.
- **Permission deferral:** `onPermissionRequest` returns `undefined`. Verify permission event still flows to the WebSocket for UI handling.

## Acceptance criteria

- Sessions dispatch to correct Runtime by provider name
- Unknown provider throws clear error with available names
- `terminateSession()` dispatches to the correct Runtime
- Event handlers (`onSessionStart`, `onSessionEnd`, `onPermissionRequest`) invoked at correct lifecycle points
- `onPermissionRequest` returning a response resolves the permission server-side
- `onPermissionRequest` returning `undefined` defers to UI (WS path)
