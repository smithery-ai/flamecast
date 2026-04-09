---
"@flamecast/sdk": minor
---

Auto-create a session when `POST /message-queue` is called without a `sessionId`. The endpoint now creates a session using the resolved agent template and working directory before enqueuing the message, so the message is immediately drainable — matching the landing page's create-then-enqueue flow.
