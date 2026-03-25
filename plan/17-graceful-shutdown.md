# 4.2 — Graceful Shutdown

**Goal:** Clean shutdown on SIGINT/SIGTERM. All runtimes dispose, no orphaned processes.

**Depends on:** Nothing (parallel with other Phase 4 units)

## What to do

- `Flamecast` signal handlers call `runtime.dispose()` on all registered runtimes
- `LocalRuntime.dispose()` kills all session host child processes
- Fix known pglite shutdown race: handle `ECONNREFUSED`/`ECONNRESET` during shutdown (already partially done in PR #58's `alchemy.run.ts`)

## Files

- **Modify:** `packages/flamecast/src/flamecast/index.ts` (signal handlers)
- **Modify:** `alchemy.run.ts` (shutdown ordering, if still used)

## Test Coverage

Integration tests in `packages/flamecast/test/graceful-shutdown.test.ts`:

- **Clean shutdown:** Start Flamecast with active sessions → send SIGTERM → verify all session host child processes killed (no orphans via `ps`)
- **Shutdown ordering:** Verify sessions terminated before storage/server closes (no DB write errors during teardown)

## Acceptance criteria

- `Ctrl+C` → all session host processes killed, no orphans
- No uncaught exceptions during shutdown
