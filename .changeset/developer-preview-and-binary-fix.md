---
"@flamecast/sdk": patch
---

Fix runtime-host binary resolution to check @flamecast/session-host-go/dist before falling back to ~/.flamecast/bin, fixing "No native runtime-host binary found" in monorepo development.
