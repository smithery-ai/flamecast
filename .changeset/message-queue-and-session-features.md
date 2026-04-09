---
"@flamecast/sdk": minor
"@flamecast/protocol": minor
"@flamecast/storage-psql": patch
"@flamecast/ui": minor
---

Add server-side message queue, session persistence, and per-session permissions

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
