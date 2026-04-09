---
"@flamecast/sdk": patch
---

Resolve landing page defaults server-side in the enqueue API. When `runtime`, `agent`, or `agentTemplateId` are omitted from `POST /message-queue`, the server now fills them in using the first available runtime and first matching agent template — matching the landing page behavior.
