---
"flamecast": patch
---

Fix daemon lifecycle: detect stale PID files from recycled PIDs, wait for server to actually start before reporting success, handle port-in-use errors gracefully, report accurate tunnel status, auto-install cloudflared when using --name, and add `flamecast status` command.
