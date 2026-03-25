# 4.3 — Health Checks + Idle Timeout

**Goal:** SessionHost self-terminates after idle. Control plane health endpoint reports status.

**Depends on:** Nothing (parallel with other Phase 4 units)

## What to do

### SessionHost idle timeout

If no WS clients connected for `IDLE_TIMEOUT` (default 30 min), the SessionHost self-terminates. Emit `session.terminated` with reason `"idle_timeout"` via WS + callback before exiting.

### Control plane health endpoint

`GET /api/health` returns runtime status:

```json
{ "status": "ok", "sessions": 3 }
```

## Files

- **Modify:** `packages/session-host/src/index.ts` (idle timeout)
- **Modify:** `packages/flamecast/src/flamecast/api.ts` (health endpoint, if changes needed)

## Test Coverage

Integration tests in `packages/flamecast/test/health-checks.test.ts`:

- **Health endpoint:** `GET /api/health` returns `{ status: "ok", sessions: N }` where N matches the actual number of active sessions
- **Idle timeout:** Start session → disconnect all WS clients → wait for timeout → verify session host self-terminated

## Acceptance criteria

- SessionHost exits after 30 min with no WS clients
- `GET /api/health` returns correct session count
