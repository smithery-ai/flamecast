# @flamecast/sdk

## 0.2.1

### Patch Changes

- dfd809b: Resolve landing page defaults server-side in the enqueue API. When `runtime`, `agent`, or `agentTemplateId` are omitted from `POST /message-queue`, the server now fills them in using the first available runtime and first matching agent template — matching the landing page behavior.

## 0.2.0

### Minor Changes

- 432c815: Add server-side message queue, session persistence, and per-session permissions
  - Add message queue API for persisting prompts server-side with auto-drain on turn completion
  - Add per-session auto-approve permissions override
  - Add settings API for backend URL and global permissions configuration
  - Add session history persistence to `.flamecast/sessions/` via event tap
  - Add `cwd` and `title` metadata fields to sessions
  - Add `QueuedMessage` type and storage methods to protocol
  - Add `message_queue` table migration and storage implementation
  - Add `useRuntimeWebSocket` hook consolidating WebSocket multiplexing per runtime
  - Add `useMessageQueue` React Query hooks for queue management
  - Extract and refactor WebSocket management across session and terminal hooks

### Patch Changes

- Updated dependencies [432c815]
  - @flamecast/protocol@0.2.0

## 0.1.2

### Patch Changes

- 711d0f1: Fix runtime-host binary resolution to check @flamecast/session-host-go/dist before falling back to ~/.flamecast/bin, fixing "No native runtime-host binary found" in monorepo development.

## 0.1.1

### Patch Changes

- f5e6639: Test changeset release
- Updated dependencies [f5e6639]
  - @flamecast/protocol@0.1.1

## 0.1.0

### Minor Changes

- a8b1702: Test publish via changeset

### Patch Changes

- Updated dependencies [a8b1702]
  - @flamecast/protocol@0.1.0
