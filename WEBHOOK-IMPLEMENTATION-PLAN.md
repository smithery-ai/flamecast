# External Webhook Delivery — Implementation Plan

RFC: https://flamecast.mintlify.app/rfcs/webhooks
Linear: SMI-1703

## Context

Tier 1 (internal callbacks) is done — session-host POSTs events to the control plane, in-process handlers fire synchronously. This plan covers Tier 2: delivering events outbound to user-registered HTTP endpoints with signing and retry.

## What exists today

- `handleSessionEvent()` dispatches 4 event types to in-process handlers
- `POST /api/agents/:id/events` receives callbacks from session-host
- `POST /api/agents/:id/prompts` sends prompts without WS
- `onPermissionRequest` returns a response synchronously (or defers to WS)
- `onSessionEnd`, `onError` are fire-and-forget
- `onAgentMessage` is disabled (too chatty per-chunk)

## RFC deviations

This plan intentionally scopes down from the RFC in several places. Each deviation is called out so we can track what's covered vs deferred.

| Area | RFC says | This plan | Rationale |
|---|---|---|---|
| Event ordering | Events delivered in order per session | Per-session/per-webhook serial queue | Matches RFC |
| `session_end` event | Not in RFC (only `end_turn`, `permission_request`, `error`) | Delivered as internal-only extension | Useful operationally; not part of the public webhook contract until RFC is updated |
| `end_turn` | Coalesced full-turn content | Phase 3b: REST-prompt subset only (fires after `connection.prompt()` resolves) | Full coalescing deferred to Phase 5; 3b covers the stateless orchestration path |
| Backpressure | Proposed: pause the agent when delivery can't keep up | Fire-and-forget with AbortController on shutdown | MVP simplification; agent is never paused by slow webhooks |
| Webhook updates | RFC leans toward supporting updates after creation | Not supported — webhooks are immutable per session | Deferred; merging at creation is simpler |
| URL scheme | RFC says HTTPS endpoint | HTTPS required; HTTP allowed only for `localhost` (dev) | Prevents accidental plaintext in production |

## Phase 1: Webhook delivery engine

**New file:** `packages/flamecast/src/flamecast/webhook-delivery.ts`

Standalone module, zero coupling to Flamecast internals. Can be built and tested independently.

### Types (in `@flamecast/protocol/session`)

```typescript
/** Webhook registration — per-session or global. */
interface WebhookConfig {
  /** Stable internal ID assigned at registration. */
  id: string;
  url: string;
  secret: string;
  events?: WebhookEventType[];
}

/** Event types deliverable via webhooks. Matches the RFC plus session_end (internal extension). */
type WebhookEventType = "permission_request" | "end_turn" | "error" | "session_end";

interface WebhookPayload {
  sessionId: string;
  eventId: string;       // UUID — stable across retries for idempotency
  timestamp: string;     // ISO 8601
  event: {
    type: WebhookEventType;
    data: Record<string, unknown>;
  };
}
```

Each `WebhookConfig` gets a stable `id` (UUID) assigned at registration time. This distinguishes duplicate URLs with different secrets or event filters.

### Delivery

```typescript
class WebhookDeliveryEngine {
  /**
   * Enqueue an event for delivery to all matching webhooks.
   *
   * Deliveries for the same (sessionId, webhookId) pair are serialized
   * to preserve event ordering per the RFC. Different sessions and
   * different webhook endpoints run concurrently.
   *
   * Pass an AbortSignal to cancel pending retries on shutdown.
   */
  async deliver(
    sessionId: string,
    eventType: WebhookEventType,
    data: Record<string, unknown>,
    webhooks: WebhookConfig[],
    signal?: AbortSignal,
  ): Promise<void>;
}
```

#### Ordering guarantee

The RFC requires events to be delivered **in order per session**. Naive `Promise.allSettled` across all events would allow later events to overtake earlier ones during retries.

**Solution:** Per-`(sessionId, webhookId)` serial queue. Each unique key gets a chain of promises — the next delivery waits for the previous one to complete (or exhaust retries). Different keys run concurrently.

```typescript
// Internal: Map<`${sessionId}:${webhookId}`, Promise<void>>
private queues = new Map<string, Promise<void>>();

private enqueue(key: string, fn: () => Promise<void>): void {
  const prev = this.queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);  // run fn after previous completes (regardless of success)
  this.queues.set(key, next);
}
```

#### Retry policy

- Retry schedule: immediate, 5s, 30s, 2m, 10m (5 attempts total)
- 10-second timeout per attempt (`AbortSignal.timeout(10_000)`)
- Success = 2xx response
- Retry on 5xx and 429 (respect `Retry-After` header when present)
- Don't retry on other 4xx (permanent client error)
- Failed deliveries after all retries: `console.warn` with event ID and webhook URL
- AbortSignal cancels pending retries (checked between attempts)

#### Signing

- HMAC-SHA256: `X-Flamecast-Signature: sha256={hmac(secret, body)}`
- Headers: `X-Flamecast-Event-Id`, `X-Flamecast-Session-Id`, `Content-Type: application/json`
- Event ID is a UUID generated once per delivery and remains stable across retries (idempotency)

#### Internal delivery record (optional but recommended)

Even for in-memory MVP, a small record model makes retries and debugging cleaner:

```typescript
interface DeliveryRecord {
  eventId: string;
  sessionId: string;
  webhookId: string;
  attempt: number;
  nextAttemptAt: number;  // timestamp
  payload: WebhookPayload;
}
```

### Signature verification helper

**Separate export:** `@flamecast/protocol/verify` (not the base protocol package).

The base `@flamecast/protocol` package is types-only. Verification helpers use `node:crypto` and belong in a runtime-specific export path so browsers, Workers, and type-only consumers aren't polluted.

```typescript
// packages/protocol/src/verify.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string,
): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

Length guard before `timingSafeEqual` prevents the throw on unequal-length buffers.

### Tests

Unit tests with intercepted fetch (vi.fn or msw):
- Delivers to matching webhooks, skips non-matching
- HMAC signature is correct and verifiable with the helper
- Event ID is stable across retries (idempotent)
- Retries on 5xx, gives up after 5 attempts
- Retries on 429, respects Retry-After header
- Doesn't retry on other 4xx
- Timeout triggers retry
- Empty webhooks array = no-op
- AbortSignal cancels pending retries
- **Ordering: two events for the same (session, webhook) are delivered serially**
- **Ordering: events for different sessions or webhooks run concurrently**

## Phase 2: Webhook config on sessions

### Protocol types

Add `WebhookConfig`, `WebhookEventType`, `WebhookPayload` to `@flamecast/protocol/session`.

Add to `CreateSessionBody`:

```typescript
interface CreateSessionBody {
  // ... existing
  webhooks?: Omit<WebhookConfig, "id">[];  // id assigned at registration
}
```

### Flamecast options

```typescript
type FlamecastOptions<R> = {
  // ... existing
  /** Global webhooks delivered for all sessions. */
  webhooks?: Omit<WebhookConfig, "id">[];
}
```

Global and per-session webhooks are **merged at session creation time** and stored as a single array on `ManagedSession`. Each entry gets a stable `id` assigned at merge time. A global webhook added after session creation does not apply retroactively.

Webhook configs are **immutable** after session creation. Update/remove after creation is deferred (RFC open question).

### Storage

Webhooks are ephemeral — same durability as the session map itself. If the control plane restarts, webhook configs are lost (along with the sessions they belong to). No database migration needed.

```typescript
interface ManagedSession {
  // ... existing
  webhooks: WebhookConfig[];  // merged global + per-session, ids assigned
}
```

Expose via `SessionService.getWebhooks(sessionId): WebhookConfig[]`.

### Validation

In `CreateSessionBodySchema` (Zod):
- `url` must be HTTPS, or HTTP only if host is `localhost` / `127.0.0.1` (dev mode)
- `secret` must be a non-empty string
- `events` if present must be a non-empty array of `WebhookEventType` values

## Phase 3: Fan-out in handleSessionEvent

Wire phases 1 and 2 together. After the in-process handler runs, deliver to external webhooks.

### Changes to `Flamecast` class

```typescript
// In constructor
this.webhookEngine = new WebhookDeliveryEngine();
this.webhookAbortControllers = new Map<string, AbortController>();

// In handleSessionEvent, after each case:
const webhooks = this.sessionService.getWebhooks(sessionId);
if (webhooks.length > 0) {
  const ac = this.webhookAbortControllers.get(sessionId) ?? new AbortController();
  this.webhookAbortControllers.set(sessionId, ac);
  void this.webhookEngine.deliver(sessionId, event.type, event.data, webhooks, ac.signal);
}

// In shutdown / terminateSession:
this.webhookAbortControllers.get(sessionId)?.abort();
this.webhookAbortControllers.delete(sessionId);
```

### Event mapping

| Internal event | Webhook event | Delivered? | Notes |
|---|---|---|---|
| `permission_request` | `permission_request` | Yes | RFC event type |
| `error` | `error` | Yes | RFC event type |
| `session_end` | `session_end` | Yes | **Internal extension** — not in RFC. Useful operationally but not part of the public webhook contract until RFC is updated. Consumers must opt in via `events: ["session_end"]`. |
| `agent_message` | — | No | Too chatty per-chunk |
| prompt response | `end_turn` | Yes (Phase 3b) | RFC event type, partial coverage — see below |

### Phase 3b: REST-prompt `end_turn` (partial RFC coverage)

The RFC defines `end_turn` as a coalesced event with full turn content. Full chunk-level coalescing is Phase 5.

Phase 3b implements a **subset**: `end_turn` fires after `connection.prompt()` resolves on the REST `/prompt` path. This gives one webhook event per prompt turn with the complete `PromptResponse`.

**This only covers prompts sent via `POST /api/agents/:id/prompts`.** Prompts sent via WS do not trigger `end_turn` webhooks until Phase 5. This is documented as partial coverage.

**Session-host change:**
```typescript
// In POST /prompt handler, after connection.prompt() resolves:
void postCallback({ type: "end_turn", data: { promptResponse: result } });
```

**Control plane change:**
Add `end_turn` case to `handleSessionEvent` — fire-and-forget webhook delivery, no in-process handler (or add `onEndTurn` for future use).

**Note:** The `end_turn` payload shape (`{ promptResponse }`) may not match the RFC's final `end_turn` shape (which shows `{ messages }` with conversation history). This is an MVP approximation. The payload shape should be revisited when Phase 5 lands full coalescing.

### Delivery timing

External delivery is **fire-and-forget** and runs **after** the in-process handler. The agent is never paused by slow webhooks — this is an MVP deviation from the RFC's tentative backpressure proposal (RFC open question #4: "pause the agent").

1. In-process handler runs (may return a permission response)
2. Webhook delivery enqueued (does not block the HTTP response to session-host)

For `permission_request`:
- If the in-process handler returns a response → session-host gets it immediately. Webhook still fires as notification.
- If the in-process handler defers → session-host falls back to WS. Webhook fires, external system can respond via REST (Phase 4).

## Phase 4: Inbound permission endpoint

`POST /api/agents/:id/permissions/:requestId`

Allows external systems to respond to permission requests that were deferred by the in-process handler.

**Scope: Node.js session-host only.** The Go session-host does not have callback support and is out of scope. Go support is a separate follow-up.

### Flow

```
1. Agent requests permission
2. Session-host POSTs to control plane
3. onPermissionRequest returns undefined (deferred)
4. Control plane returns { deferred: true } to session-host
5. Session-host falls back to WS promise (permissionResolvers)
6. Webhook delivers permission_request to external system
7. ... time passes ...
8. External system POSTs to /api/agents/:id/permissions/:requestId
9. Control plane forwards response to session-host
10. Session-host resolves the WS promise, agent continues
```

### Bridging back to session-host (step 9)

**Approach: HTTP.** Add `POST /permissions/:requestId` to session-host's HTTP server. Control plane calls it via `sessionService.proxyRequest()`. Reuses existing pattern, no WS connection needed.

### Session-host changes (Node.js only)

New endpoint:

```
POST /permissions/:requestId
{ "optionId": "allow" }
```

Resolves the `permissionResolvers` promise for that requestId. Returns 200 on success, 404 if requestId not found (expired or already resolved).

### Control plane route

```
POST /api/agents/:agentId/permissions/:requestId
{ "optionId": "allow" }
```

Validates the body, then calls `sessionService.proxyRequest(agentId, "/permissions/" + requestId, { method: "POST", body })`.

## Phase 5 (future): Full `end_turn` coalescing

Phase 3b gives us `end_turn` for REST-initiated prompts. This future phase adds `end_turn` for WS-driven prompts too (where there's no single HTTP response to hook into):

1. Re-enable `agent_message` callbacks from session-host
2. Buffer chunks in the control plane per session
3. Detect "turn complete" (agent yields / `stopReason` received)
4. Coalesce buffered chunks into a single `end_turn` payload matching the RFC's payload shape
5. Deliver as one webhook POST

Not needed for MVP since the REST `/prompt` → `end_turn` path covers the primary use case (stateless orchestration via webhooks).

## Summary

| Phase | What | Depends on | Complexity |
|---|---|---|---|
| 1 | Webhook delivery engine + verification helper + event types | Nothing | Low |
| 2 | Webhook config on sessions + FlamecastOptions | Phase 1 types | Low |
| 3 | Fan-out in handleSessionEvent | Phases 1+2 | Low |
| 3b | REST-prompt `end_turn` subset | Phase 3 | Low |
| 4 | Inbound permission endpoint (Node.js session-host) | Phase 3 | Medium |
| 5 | Full `end_turn` coalescing for WS prompts | Phase 3 | High (future) |

Phases 1–3b are the MVP. External systems get `permission_request`, `end_turn` (REST-prompt only), and `error` via RFC webhook contract, plus `session_end` as an internal extension.

## Usage after phases 1–3b

```typescript
const flamecast = new Flamecast({
  runtimes: { default: new NodeRuntime() },

  // Global webhooks — every session gets these
  webhooks: [
    {
      url: "https://my-app.com/api/flamecast-events",
      secret: "whsec_abc123",
      events: ["end_turn", "error"],
    },
  ],

  // In-process handlers still work alongside webhooks
  onPermissionRequest: async (c) => {
    if (c.kind === "file_read") return c.allow();
    return undefined;  // defer to webhook → Slack
  },
});
```

```bash
# Per-session webhooks
curl -X POST http://localhost:3001/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "agentTemplateId": "codex",
    "webhooks": [
      {
        "url": "https://my-slack-bot.vercel.app/api/events",
        "secret": "whsec_def456",
        "events": ["permission_request", "end_turn", "error"]
      }
    ]
  }'
```

### Consumer verification

```typescript
import { verifyWebhookSignature } from "@flamecast/protocol/verify";

export async function POST(req: Request) {
  const body = await req.text();
  const signature = req.headers.get("X-Flamecast-Signature")!;

  if (!verifyWebhookSignature(process.env.WEBHOOK_SECRET!, body, signature)) {
    return new Response("invalid signature", { status: 401 });
  }

  const event = JSON.parse(body);
  // handle event...
}
```
