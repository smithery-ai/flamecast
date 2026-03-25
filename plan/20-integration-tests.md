# 4.5 — Integration Test Suite

**Goal:** Full end-to-end test coverage for the new architecture.

**Depends on:** All Phase 1-4 units

## Testing philosophy

All tests run against real Flamecast instances with real session host processes and real agents. No mocking of internal components. Mock only external platform APIs (Fly, E2B). Each test verifies an invariant visible through the public API or WS protocol.

This means:

- Tests start a real `Flamecast` instance (in-memory storage, LocalRuntime)
- Tests create real sessions that spawn real session host child processes
- Tests connect real WebSocket clients and send real prompts
- Tests verify results through `GET /api/...` endpoints and WS message assertions
- The only mocks are for external cloud provider APIs that would incur cost or require credentials

## What to do

| Test file                   | What it verifies                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-lifecycle.test.ts` | Create → prompt → permission → approve → complete → terminate. Verifies the full happy-path lifecycle is observable through the API and WS.                           |
| `permission-flow.test.ts`   | Permission request → approve, reject, cancel. Server-side handler resolution. Verifies permission state transitions are correct and visible to all connected clients. |
| `filesystem.test.ts`        | Snapshot on connect, file preview, file watcher updates. Verifies filesystem state is consistent between session host and WS clients.                                 |
| `event-persistence.test.ts` | Events in DB, reconnect replay, callback failure. Verifies the persistence pipeline does not lose events and failures are isolated.                                   |
| `local-runtime.test.ts`     | Spawn, health check, dispose, listen (sidecar mode). Verifies child process management invariants — no orphans, clean teardown.                                       |
| `remote-runtime.test.ts`    | HTTP forwarding, error propagation. Uses a mock HTTP server standing in for Fly/E2B API. Verifies request/response contracts.                                         |
| `session-service.test.ts`   | Runtime dispatch, unknown provider, event handlers. Verifies the correct runtime is selected and errors propagate as expected API responses.                          |

## Files

- **New/Update:** `packages/flamecast/test/*.test.ts`
- **New/Update:** `packages/session-host/test/session-host.test.ts`

## Test Coverage

This file IS the test coverage plan for the full integration suite. Every test file listed above is an integration test. The invariants each test guards:

- **session-lifecycle:** A session moves through all expected states in order, observable via API
- **permission-flow:** Permission state machine transitions are correct and consistent across clients
- **filesystem:** File state visible to clients matches actual filesystem
- **event-persistence:** Events written to DB match events delivered via WS
- **local-runtime:** Child processes are tracked and cleaned up (no orphans after dispose)
- **remote-runtime:** HTTP contract between control plane and remote runtime is correct
- **session-service:** Runtime selection logic routes to the correct provider

## Acceptance criteria

- All tests pass
- `pnpm test` green
- `pnpm check` green (lint + format + build + test)
