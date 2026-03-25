# 2.7 — Phase 2 Tests

**Goal:** Test coverage for the Runtime interface, SessionService, and named runtime dispatch.

**Depends on:** 2.4 (SessionService), 2.5 (constructor), 2.6 (entry points)

## Test Philosophy

All tests spin up real runtime instances and real session host processes. Mock only external services (Fly API, E2B API). The goal is to verify the **Runtime -> SessionHost -> ACP -> Agent** pipeline works correctly through the actual code paths, not through mocked interfaces.

Every test should catch a real regression. No trivial assertions.

## What to do

### SessionService tests (`packages/flamecast/test/session-service.test.ts`)

- **Runtime dispatch:** Register two real runtimes. `createSession()` with each provider. Verify correct runtime receives the request by checking the spawned process / forwarded HTTP call.
- **Unknown provider:** `createSession` with unregistered provider. Verify error message lists available providers.
- **Terminate dispatch:** Create session with runtime A. Terminate it. Verify runtime A receives the terminate request and the session host process exits.
- **Event handler invocation:** Register `onPermissionRequest`, `onSessionStart`, `onSessionEnd`. Run a session through its lifecycle. Verify each handler fires with correct `SessionContext`.
- **Server-side permission resolution:** `onPermissionRequest` returns `{ optionId: "allow" }`. Verify tool completes without WS involvement.
- **Permission deferral:** `onPermissionRequest` returns `undefined`. Verify permission event flows to WS.

### LocalRuntime tests (`packages/flamecast/test/local-runtime.test.ts`)

- **Spawn lifecycle:** `POST /start` spawns a real session host. Health check passes. `POST /terminate` kills it. Process exits cleanly.
- **Port isolation:** Start two sessions. Each gets a different port. Requests to each are routed correctly.
- **Dispose cleanup:** Start 3 sessions. `dispose()`. All child processes killed, no orphans (`ps` check).
- **Sidecar mode:** `listen()` starts HTTP server. Full lifecycle works through the HTTP interface.

### RemoteRuntime tests (`packages/flamecast/test/remote-runtime.test.ts`)

- **HTTP forwarding:** Start a real mock HTTP server. `RemoteRuntime({ url })`. Verify path rewriting, method, headers, and body arrive correctly.
- **Error propagation:** Mock returns 500. Verify status and body pass through.
- **Session not found:** Mock returns 404 for unknown session. Verify it passes through.

## Files

- **New:** `packages/flamecast/test/session-service.test.ts`
- **New:** `packages/flamecast/test/local-runtime.test.ts`
- **New:** `packages/flamecast/test/remote-runtime.test.ts`

## Acceptance criteria

- All tests pass with `pnpm test`
- Tests use real child processes and real HTTP servers (no fetch mocks, no process mocks)
- External service APIs (Fly, E2B) are the only things mocked
- Test suite completes in under 30 seconds (parallel where possible)
