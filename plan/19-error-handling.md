# 4.4 — Error Handling

**Goal:** Handle failure modes gracefully across the stack.

**Depends on:** Nothing (parallel with other Phase 4 units)

## What to do

| Failure                            | Fix                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| Session host child process crashes | `LocalRuntime` detects exit event, marks session as "killed" in storage      |
| Agent process exits unexpectedly   | SessionHost emits `session.terminated` with reason via WS + callback         |
| Runtime fails to provision         | `SessionService.createSession()` returns 503 to client                       |
| Event callback fails               | Log warning, don't block WS delivery                                         |
| WS connection drops                | Client auto-reconnects (existing), replays from DB if Phase 3 is implemented |

## Files

- **Modify:** `packages/flamecast/src/flamecast/runtimes/local.ts` (child process exit handling)
- **Modify:** `packages/session-host/src/index.ts` (agent exit → session.terminated)

## Test Coverage

Integration tests in `packages/flamecast/test/error-handling.test.ts`:

- **Session host crash:** Start session → kill the session host process externally → verify session status becomes `"killed"` in API
- **Agent exit:** Start session with an agent that exits immediately → verify `session.terminated` event with reason
- **Runtime provisioning failure:** Register a runtime that always fails → `POST /api/agents` → verify 503 response with clear error

## Acceptance criteria

- Kill a session host process → session status becomes "killed"
- Agent exits → `session.terminated` event with reason
- Runtime start fails → 503 response, clear error message
