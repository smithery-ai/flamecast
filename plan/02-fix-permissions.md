# 1.2 — Fix Permission Prompting (Gap #1 + #8)

**Goal:** Permission request events from the SessionHost are correctly rendered in the frontend. Sessions no longer get stuck on pending tool calls.

**Depends on:** 1.1 (shared protocol types)

## Root cause

The session host emits `permission_request` events with flat data: `{ requestId, toolCallId, title, kind, options }`.

The frontend checks `event.data.pendingPermission` — a wrapper property that doesn't exist. Both the direct check (line 89) and the RPC fallback (lines 93-104) fail.

## What to do

### Frontend (`packages/flamecast/src/client/routes/sessions.$id.tsx`)

1. Import `PermissionRequestEvent` from `@flamecast/sdk/shared/session-host-protocol`

2. Replace the `pendingPermission` derivation (~line 89):

```typescript
// BEFORE (broken)
if (event.type === "permission_request" && event.data.pendingPermission) {
  return event.data.pendingPermission as PendingPermission;
}

// AFTER (use shared type, check for flat shape)
if (event.type === "permission_request" && event.data.requestId) {
  return event.data as PermissionRequestEvent;
}
```

3. Remove the broken RPC fallback path (lines 93-104) — unnecessary now that the session host emits a proper typed event.

### SessionHost (`packages/session-host/src/index.ts`)

1. Import `PermissionRequestEvent` from `@flamecast/sdk/shared/session-host-protocol`
2. Verify `emitEvent("permission_request", ...)` matches the shared type (it should already — the flat shape is correct)

### Verify round-trip

Ensure `permission.respond` messages from the client reach the session host's resolver:

- The `requestId` the client sends must match what the session host stored in `permissionResolvers` Map
- Check `permission.respond` handling in session host `index.ts:190`

## Files

- **Modify:** `packages/flamecast/src/client/routes/sessions.$id.tsx`
- **Modify:** `packages/session-host/src/index.ts` (import shared types, verify shape)

## Test Coverage

Integration tests (real Flamecast instance + real session host process, no mocks):

1. **Full round-trip:** Create session → send prompt → verify `permission_request` WS event has `{ requestId, title, kind, options }` shape → send `permission.respond` → verify tool completes and agent responds
2. **Reject flow:** Send `permission.respond` with reject → verify tool is skipped
3. **Send button state:** While permission is pending, verify prompt input is disabled with "Permission required" label
4. **Stale permission:** Approve a permission → verify no stale permission UI remains

## Acceptance criteria

- Send a prompt that triggers a tool with permission → "Allow this change" / "Skip" / "Cancel" buttons appear
- Click "Allow" → tool completes, agent continues
- Click "Skip" → tool is skipped, agent continues
- Send button shows "Permission required" (disabled) while permission is pending
- Gap #8 auto-resolves (send button state)
