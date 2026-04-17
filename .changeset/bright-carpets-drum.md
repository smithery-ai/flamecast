---
"flamecast": patch
---

Close active terminal websocket connections during CLI shutdown so `flamecast up` does not remain stuck on `Shutting down...` while browser clients are still connected.
