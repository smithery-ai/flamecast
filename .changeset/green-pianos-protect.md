---
"@flamecast/sdk": minor
"flamecast": minor
---

Add terminal session management APIs to `@flamecast/sdk`, including typed `/api/terminals` routes, WebSocket terminal streaming, MCP handlers/tools, OpenAPI docs, and exported client/session helpers for embedding Flamecast in other apps.

Update the `flamecast` CLI to run the server in the foreground with cleaner `up`/`down`/`status` lifecycle handling and optional named tunnel provisioning via `flamecast up --name <name>`.
