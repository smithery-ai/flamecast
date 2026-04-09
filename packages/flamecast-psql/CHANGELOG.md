# @flamecast/storage-psql

## 0.1.5

### Patch Changes

- Updated dependencies [dfd809b]
  - @flamecast/sdk@0.2.1

## 0.1.4

### Patch Changes

- 98fddf9: Add default agent templates for Claude Code and Codex

## 0.1.3

### Patch Changes

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

- Updated dependencies [432c815]
  - @flamecast/sdk@0.2.0
  - @flamecast/protocol@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [711d0f1]
  - @flamecast/sdk@0.1.2

## 0.1.1

### Patch Changes

- f5e6639: Test changeset release
- Updated dependencies [f5e6639]
  - @flamecast/sdk@0.1.1
  - @flamecast/protocol@0.1.1

## 0.1.0

### Minor Changes

- a8b1702: Test publish via changeset

### Patch Changes

- Updated dependencies [a8b1702]
  - @flamecast/sdk@0.1.0
  - @flamecast/protocol@0.1.0
