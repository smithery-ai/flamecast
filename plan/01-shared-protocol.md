# 1.1 — Shared Protocol Contract

**Goal:** Define shared TypeScript types for the session host↔frontend event protocol. Both `packages/session-host` and `packages/flamecast/src/client` import these. This prevents the permission event shape mismatch (Gap #1) from recurring.

**Depends on:** Nothing (can start immediately)

## What to do

Create `packages/flamecast/src/shared/session-host-protocol.ts` with types for:

### SessionHost → Client events

```typescript
export interface PermissionRequestEvent {
  requestId: string;
  toolCallId: string;
  title: string;
  kind?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface FilesystemSnapshotEvent {
  snapshot: {
    root: string;
    entries: FileSystemEntry[];
  };
}

export interface FilePreviewEvent {
  path: string;
  content: string;
}
```

### Client → SessionHost actions

```typescript
export interface PermissionRespondAction {
  action: "permission.respond";
  requestId: string;
  response: { optionId: string };
}

export interface FsSnapshotAction {
  action: "fs.snapshot";
  path?: string;
}

export interface FilePreviewAction {
  action: "file.preview";
  path: string;
}
```

### SessionHost HTTP contract

```typescript
export interface SessionHostStartRequest {
  command: string;
  args: string[];
  workspace: string;
  setup?: string;
  callbackUrl?: string;
}

export interface SessionHostStartResponse {
  acpSessionId: string;
  hostUrl: string;
  websocketUrl: string;
}
```

## Notes

- `ws-protocol.ts` already exists in `src/shared/` for the WS message envelope types. `session-host-protocol.ts` extends this with session-host-specific event payload shapes and the SessionHost HTTP contract.
- The session host (`packages/session-host`) imports from `@flamecast/sdk/shared/session-host-protocol` for type-only usage. It already depends on `@agentclientprotocol/sdk`, so adding a type-only import is lightweight.
- PR #58 returned `port` in the start response. Replace with `hostUrl` — what the caller actually needs. `LocalRuntime` constructs `hostUrl` from `localhost:PORT`.

## Files

- **New:** `packages/flamecast/src/shared/session-host-protocol.ts`
- **Verify:** `packages/flamecast/package.json` exports `./shared/session-host-protocol`

## Test Coverage

No tests needed — types only, compile-time verification. The protocol contract is tested implicitly by all other tests that import these types.

## Acceptance criteria

- Types compile and are importable from both `packages/session-host` and `packages/flamecast/src/client`
- No runtime code — types only
