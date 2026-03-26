# Flamecast RFC Audit — 2026-03-25

Cross-reference of all 8 RFCs against the codebase and Linear issues.

## Summary

| # | RFC | Implementation Status | Linear Ticket | Notes |
|---|-----|----------------------|---------------|-------|
| 1 | [Unified Runtime](#1-unified-runtime) | Partially implemented | SMI-1680 (Done), SMI-1702 (Todo) | Core runtime interface done; progressive disclosure layers not started |
| 2 | [Setup Scripts](#2-setup-scripts) | Implemented | None | Shipped in PR #61, wired through `SessionHostStartRequest.setup` |
| 3 | [Pre-built Images](#3-pre-built-images) | Not started | SMI-1702 (Todo) | Blocked on static session-host binary decision |
| 4 | [Dockerfile Validation](#4-dockerfile-validation) | Not started | None | No Linear ticket |
| 5 | [Terminal Sessions](#5-terminal-sessions) | Stubbed | SMI-1683 (Todo) | ACP client stubs exist in session-host; no real PTY streaming |
| 6 | [Multi-Session WebSocket](#6-multi-session-websocket-adapter) | Not started | None | No Linear ticket |
| 7 | [Queue Management](#7-queue-management) | Partially implemented | None | Basic serial queue exists; no REST API, reorder, pause/resume |
| 8 | [Webhooks](#8-webhook-event-delivery) | Not started | SMI-1659 (In Progress) | Slack/Discord adapters in progress; webhook infra not started |

---

## Detailed Analysis

### 1. Unified Runtime

**RFC**: Single template definition works across local and Docker runtimes with progressive disclosure (zero config → packages → custom Dockerfile).

**Implementation status**: **Partial**

What's done:
- `Runtime<TConfig>` interface in `@flamecast/protocol` with `fetchSession()` — ships in PR #71
- `NodeRuntime`, `DockerRuntime`, `E2BRuntime` all implement the interface
- Named runtimes on `Flamecast({ runtimes: { ... } })` — landed in PR #61 (SMI-1680)
- `setup` field flows through `SessionHostStartRequest` to session-host
- Templates reference runtimes by name (`runtime: { provider: "docker" }`)

What's NOT done:
- **Layer 2: `packages` field** — not in `AgentTemplate` interface, not implemented
- **Runtime inference** — DockerRuntime doesn't auto-select base image from `spawn.command`
- **`managedEntrypoint`** — Dockerfile CMD still defines behavior; no entrypoint injection
- **Portable templates** — switching a template from `local` to `docker` still requires Dockerfile or image config changes
- **`setupTimeout`** — not in the interface

**Linear tickets**:
- **SMI-1680** (Done) — "Parameterize Runtime on agent template creation" — covers named runtimes
- **SMI-1702** (Todo) — "Support base images with static session-host binary" — plans to compile session-host to Go binary so any base image works. This would enable the zero-config Docker experience from the RFC

**Gap**: No ticket for `packages` field, runtime inference, or `managedEntrypoint: false` backward compat.

---

### 2. Setup Scripts

**RFC**: Optional `setup` string on agent templates, executed as `sh -c` before `spawn`.

**Implementation status**: **Implemented**

- `setup` field exists on `AgentTemplateRuntime` in `@flamecast/protocol/session`
- `SessionHostStartRequest` carries `setup` to session-host
- Session-host runs setup via `exec` when `RUNTIME_SETUP_ENABLED` env var is set
- DockerRuntime sets `RUNTIME_SETUP_ENABLED=1` in containers
- Setup runs before agent spawn in `doStartSession()`

**What's NOT done**:
- `setupTimeout` field (RFC proposes per-template override, default 5min) — not implemented
- Setup output is not captured/streamed to client — runs in background with `exec`
- No caching of setup results across sessions

**Linear tickets**: None specifically for setup scripts (it was part of the broader PR #61 work).

---

### 3. Pre-built Images

**RFC**: Ship `ghcr.io/anthropics/flamecast/node`, `python`, `base` images with managed entrypoint.

**Implementation status**: **Not started**

- No pre-built images exist
- No GHCR publishing pipeline
- DockerRuntime uses a fallback image (`flamecast-session-host`) but this is a local build, not a published pre-built image
- No managed entrypoint that coordinates setup → spawn

**Linear tickets**:
- **SMI-1702** (Todo) — "Support base images with static session-host binary" — the team decided to compile session-host to a Go binary instead of shipping Node-based images. This changes the approach: instead of pre-built images with Node, ship a static binary that can be added to *any* base image.

**Gap**: The Go rewrite of session-host is a prerequisite. No ticket for the image publishing pipeline itself.

---

### 4. Dockerfile Validation

**RFC**: Detect `CMD` vs `spawn` conflicts, configurable `spawnConflict: "warn" | "error" | "ignore"`.

**Implementation status**: **Not started**

- No image inspection for CMD extraction
- No `spawnConflict` option on DockerRuntime
- No warning/error when CMD and spawn conflict
- DockerRuntime just passes requests through without validation

**Linear tickets**: None.

**Note**: The unified runtime RFC's `managedEntrypoint` mode would make this RFC less critical — if Flamecast always controls the entrypoint, CMD conflicts become a warning rather than a source of bugs.

---

### 5. Terminal Sessions

**RFC**: Stream agent terminal (PTY) output over WebSocket for real-time shell visibility.

**Implementation status**: **Stubbed**

In `session-host/src/index.ts`, the ACP client has terminal stubs:
```
createTerminal → returns fake { terminalId }
terminalOutput → no-op
releaseTerminal → no-op
waitForTerminalExit → returns fake { exitCode: 0 }
killTerminal → no-op
```

These satisfy the ACP protocol interface but don't actually create PTYs or stream output.

What's NOT done:
- No PTY spawning
- No `terminal.started`, `terminal.data`, `terminal.exit` WS messages
- No `terminal.input`, `terminal.resize` client→server actions
- No `useTerminal` React hook
- No REST endpoint for terminal history
- No xterm.js integration

**Linear tickets**:
- **SMI-1683** (Todo) — "Support terminal(s) over websocket" — matches this RFC exactly

---

### 6. Multi-Session WebSocket Adapter

**RFC**: Channel-based subscription model (`subscribe`/`unsubscribe`) over a single WS connection. Supports `agent:{id}`, `session:{id}:terminal`, etc.

**Implementation status**: **Not started**

Current architecture is one WS connection per session, connected directly to session-host. There is no multiplexed WS endpoint on the Flamecast server.

What's NOT done:
- No `ws://localhost:3001/ws` unified endpoint
- No channel subscription/unsubscription
- No `useFlamecast`, `useSession`, `useAgent` composed hooks
- No `FlamecastProvider` context
- No history replay on subscribe
- No `session.create` over WS

**Linear tickets**: None.

**Note**: This is a significant architectural change. The current model (client connects directly to session-host WS) would need to be augmented with a server-side WS proxy/multiplexer.

---

### 7. Queue Management

**RFC**: REST API and React hooks for viewing, reordering, pausing, and clearing the prompt queue.

**Implementation status**: **Partial**

What exists:
- `PromptQueueState`, `PromptQueueItem`, `QueuedPromptResponse` types in `@flamecast/protocol/session`
- Session-host handles `prompt` and `cancel` actions over WS
- Serial prompt processing (one at a time per session)
- `promptQueue` field on `Session` type

What's NOT done:
- No `GET /api/sessions/:id/queue` endpoint
- No `PUT /api/sessions/:id/queue` (reorder)
- No `DELETE /api/sessions/:id/queue` (clear)
- No `POST /api/sessions/:id/queue/pause` or `/resume`
- No `queue.reorder`, `queue.clear`, `queue.pause`, `queue.resume` WS actions
- No `useQueue` React hook
- No drag-and-drop reordering UI

**Linear tickets**: None.

---

### 8. Webhook Event Delivery

**RFC**: Register webhook URLs on session creation, receive events as HTTP POST with HMAC-SHA256 signatures.

**Implementation status**: **Not started**

- No `webhooks` field on session creation
- No webhook delivery infrastructure
- No signature verification
- No retry/backoff logic
- No `POST /api/agents/:id/prompts` REST endpoint (needed for stateless orchestration)
- No `POST /api/agents/:id/permissions/:requestId` REST endpoint

**Linear tickets**:
- **SMI-1659** (In Progress) — "Chat connectors for Flamecast" — building Slack/Discord adapters. This is the consumer that would benefit from webhooks, but the ticket focuses on chat adapter code, not the underlying webhook delivery infrastructure.
- **SMI-1681** (Todo) — "Support tools RFC" — related to integrations/tools but not webhooks specifically

**Note**: The `onPermissionRequest` and `onSessionEnd` event handlers on the `Flamecast` class provide a programmatic alternative to webhooks for in-process use cases. Webhooks would extend this to out-of-process consumers.

---

## Issues Without RFCs

These Linear tickets describe work that has no corresponding RFC:

| Ticket | Title | Status | Notes |
|--------|-------|--------|-------|
| SMI-1678 | Configure agent template seed directory | Todo | Would need RFC for how seed dirs interact with setup/spawn |
| SMI-1660 | ACP Steering | Todo | Mid-turn message injection; ACP protocol question |
| SMI-1679 | Bundle UI into apps/server | Todo | Scaffold/DX concern, not a protocol RFC |
| SMI-1696 | Pin Node versions | Todo | Infra/DX, resolved by Go binary approach |
| SMI-1530 | Bill end users for RPC usage | Backlog | Billing/identity, not Flamecast-specific |

## RFCs Without Tickets

| RFC | Priority | Recommended Action |
|-----|----------|-------------------|
| Dockerfile Validation | Low | Deprioritize — unified runtime's managed entrypoint makes this less critical |
| Multi-Session WebSocket | Medium | Create ticket — needed for tabbed UIs, dashboards, and the composed hook architecture |
| Queue Management | Low | Create ticket — basic queue works; advanced features can wait |
| Webhook Event Delivery | High | Create ticket — blocks stateless Slack/Discord integration (SMI-1659) |
