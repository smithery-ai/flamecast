# 1.5 — Phase 1 Tests

**Goal:** Restore test coverage for the critical paths fixed in Phase 1.

**Depends on:** 1.2, 1.3, 1.4

## What to do

### Permission round-trip test

- Create session → send prompt that triggers a tool with permission
- Verify `permission_request` event arrives over WS with correct shape (matches `PermissionRequestEvent`)
- Send `permission.respond` with `{ optionId: "allow" }`
- Verify tool completes and agent responds

### Filesystem test

- Create session → verify `filesystem.snapshot` event arrives on WS connect
- Verify snapshot has `{ root, entries }` with correct workspace path
- Send `fs.snapshot` action → verify response contains directory tree
- Send `file.preview` action with a known file path → verify content returned

### Template seeding test

- Run seed script with `SEED_LOCAL=true`
- Verify Example agent and Codex ACP templates exist in DB
- Verify `GET /api/agent-templates` returns both

### Test approach

All tests spin up a **real Flamecast instance** with a real session host process — no mocking of the session host, WebSocket layer, or database. The test harness:

1. Starts the Flamecast dev server (API + WS) against a test database
2. Seeds templates via the seed script
3. Creates sessions through the real `POST /api/agents` endpoint
4. Connects to sessions via real WebSocket connections
5. Sends prompts and actions through the WS protocol and asserts on the events that come back

This ensures tests verify the actual integration surface — the same code paths users hit in production.

## Test Coverage

Integration tests (real Flamecast instance + real session host process, no mocks):

### Permission round-trip

1. **Approve flow:** Create session → send prompt triggering a permissioned tool → verify `permission_request` WS event matches `PermissionRequestEvent` shape → send `permission.respond` with allow → verify tool completes and agent responds
2. **Reject flow:** Same setup → send `permission.respond` with reject → verify tool is skipped and agent continues

### Filesystem

3. **Snapshot on connect:** Create session → connect WS → verify `filesystem.snapshot` event arrives with `{ root, entries }` matching workspace
4. **Request snapshot:** Send `fs.snapshot` action → verify response contains directory tree
5. **File preview:** Send `file.preview` for a known file → verify content matches disk
6. **File preview error:** Send `file.preview` for nonexistent path → verify error response
7. **File watcher:** Agent modifies a file → verify updated `filesystem.snapshot` arrives over WS

### Template seeding

8. **Templates available:** `GET /api/agent-templates` returns both Example agent and Codex ACP with correct `{ id, name, spawn, runtime }` shape
9. **Start from template:** `POST /api/agents { agentTemplateId: "example" }` returns an active session with a valid WS URL

## Files

- **New:** `packages/session-host/test/session-host.test.ts`
- **Update:** `packages/flamecast/test/api.test.ts` (if applicable)

## Acceptance criteria

- All 9 integration tests pass against a real running instance
- `pnpm test` green
