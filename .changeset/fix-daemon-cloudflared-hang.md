---
"flamecast": patch
---

Fix daemon hanging when cloudflared is not installed

When running `flamecast up --name <name>` on a server without cloudflared, the daemon would hang forever because `ensureCloudflared()` tried to prompt for user confirmation via `readline` on stdin — but in daemon mode stdin is `/dev/null`, so the prompt never resolves. Now detects non-interactive mode and auto-installs cloudflared without prompting.
