# Session Handoff: Restate Control Plane for ACP Agent Orchestration

**Date:** 2026-03-31
**Your role:** Architectural advisor + agent shepherd. You steer coding agents (claude-teams sessions) working on the Flamecast Restate integration. You review their output, unblock them when stuck, and ensure alignment with the SDD.

---

## 1. What We're Building

Flamecast is an agent orchestration platform. We're adding Restate as the durable control plane for ACP agents. Two protocol-specific Restate Virtual Objects (IbmAgentSession, ZedAgentSession) orchestrate agent lifecycles with durable execution, zero-cost suspension, and crash recovery.

**Single source of truth:** `docs/sdd-durable-acp-bridge.md` (v10, 1012 lines). Read this first — it has everything.

## 2. Two ACP Protocols (Critical Context)

Two different protocols share the "ACP" name:

| | Zed ACP (Agent Client Protocol) | IBM ACP (Agent Communication Protocol) |
|---|---|---|
| Transport | JSON-RPC over stdio | REST over HTTP |
| Ecosystem | 32 agents (Codex, Claude, Gemini, Cursor, Copilot...) | Enterprise (BeeAI, LangChain) |
| Flamecast VO | `ZedAgentSession` — single blocking `ctx.run("prompt")` | `IbmAgentSession` — create + awakeable (zero compute wait) |

## 3. Current State

### Branch: `feat/restate-collapse` (SOURCE OF TRUTH)

Note: `feat/restate-vo-collapse` also exists on the remote — ignore it, it's an earlier abandoned attempt. `feat/restate-session-runtime` is the original Restate integration PR (precursor to this work). Only `feat/restate-collapse` has the current implementation.

### Epic: `mono-xhv2` — run `bd show mono-xhv2` for full status

### Completed tasks (7 of 13):

| Task | File | Status |
|---|---|---|
| 1a: AgentAdapter interface + types | `src/adapter.ts` (180 lines) | ✓ Done |
| 1b: Shared VO handlers + helpers | `src/shared-handlers.ts` (176 lines) | ✓ Done |
| 1c: IbmAcpAdapter | `src/ibm-acp-adapter.ts` (298 lines) | ✓ Done |
| 1d: IbmAgentSession VO | `src/ibm-agent-session.ts` | ✓ Done |
| 1e: watchAgentRun SSE listener | `src/watch-agent-run.ts` (182 lines) | ✓ Done |
| 3a: ZedAcpAdapter | `src/zed-acp-adapter.ts` (493 lines) | ✓ Done |
| 3b: ZedAgentSession VO | `src/zed-agent-session.ts` | ✓ Done |

All files in `packages/flamecast-restate/src/`. Everything compiles clean. Both VOs registered on endpoint.

### Remaining tasks:

| Task | ID | Status | Notes |
|---|---|---|---|
| 1f: IBM E2E test (Python) | mono-35en | In progress | Agent was stuck writing tests — redirected to follow existing test pattern |
| 3c: Zed E2E test (Codex) | mono-6xut | In progress | Same — write simple tests with mocked agents |
| 2a: Pubsub event publishing | mono-kf5h | Open | Depends on 1d (done) |
| 2b: Client SSE endpoint | mono-sn5a | Open | Depends on 2a, 1e |
| 4a: Session-host ACP bridge SDD | mono-iyby | Open | Separate SDD, lower priority |
| 5a: Eliminate old layers | mono-80in | Open | Final cleanup, depends on everything |

### Dependency graph:
```
1a ✓ → 1b ✓ ──┬──→ 1d ✓ → 1e ✓ → 1f (in progress)
             │                  → 2a → 2b
    → 1c ✓ ──┘
    → 3a ✓ → 3b ✓ → 3c (in progress)
                          → 4a → 5a
```

## 4. Key Architecture Rules (Enforce These)

1. **Two VOs, not one with branching.** `IbmAgentSession` and `ZedAgentSession` are separate. Shared handlers spread in via `...sharedHandlers`.

2. **IBM path: create + awakeable.** `ctx.run("create-run")` → publish `run.started` with `runId` → `ctx.awakeable()` → SUSPEND (zero compute). External SSE listener resolves awakeable. NEVER poll inside `ctx.run()`.

3. **Zed path: single blocking prompt.** `ctx.run("prompt", () => adapter.promptSync())` blocks until done. Needs increased Restate inactivity timeout.

4. **Streaming vs journaling are separate paths.** `ctx.run()` wraps `promptSync()` (complete result). Streaming happens outside the VO — API layer forwards tokens via pubsub. NEVER stream inside `ctx.run()`.

5. **Generation counter on pause/resume.** `pending_pause` has a `generation` field. `resumeAgent` shared handler checks it before resolving awakeable. Prevents stale resumes after cancel/steer.

6. **SessionHandle includes connection state.** `url`, `pid`, `containerId`, `sandboxId` — for reconnection after replay.

7. **`steer` is a VO handler, NOT an adapter method.** Composes `cancel()` → `setConfigOption()` → `promptSync()` as separate `ctx.run()` steps.

8. **VO is control plane, session-host is data plane.** The VO orchestrates lifecycle/permissions/state. The session-host manages stdio pipes, terminal PTY, file access. They're complementary.

9. **SSE + REST, not WebSockets** (except terminal PTY). Restate pubsub for all events. WebSocket only for terminal byte streaming.

## 5. Active Coding Agents

### Surface:42 — "Implement Restate Control Plane for ACP Agent Orchestration"
- On branch `feat/restate-collapse`
- Was writing E2E tests (1f, 3c) when it got stuck in extended thinking
- Last instruction: "Write simple test files following existing pattern at `packages/flamecast-restate/test/restate-session-service.test.ts`. Mock agents. 50-100 lines each."
- Uses `@restatedev/restate-sdk-testcontainers` (RestateTestEnvironment)
- Check: `cmux read-screen --surface surface:42 --lines 30`

### Surface:30 — "Review flamecast restate session runtime changes"
- SDD authoring agent. Wrote the v10 SDD. May be idle now.

### Surface:16 — "Collapse session-host into Restate Virtual Object"
- Previous coding agent. Idle. Did the earlier refactoring work (session-runtime abstraction, Forge pattern cleanup).

## 6. How to Monitor

```bash
# Check coding agent output
cmux read-screen --surface surface:42 --lines 30

# Send instructions to coding agent
cmux send --surface surface:42 "your message"
cmux send-key --surface surface:42 Enter

# Check epic status
cd ~/smithery/flamecast-v2 && bd show mono-xhv2

# Check available tasks
bd ready

# Verify builds
cd ~/smithery/flamecast-v2/packages/flamecast-restate && npx tsc --noEmit

# Check Restate (if running)
restate invocations list
restate services list
restate kv get IbmAgentSession <sessionId>
```

## 7. Key Files

| File | Purpose |
|---|---|
| `docs/sdd-durable-acp-bridge.md` | SDD v10 — single source of truth |
| `docs/sdd-restate-runtime.md` | Original Restate integration SDD (v2, older) |
| `packages/flamecast-restate/src/adapter.ts` | AgentAdapter interface + all types |
| `packages/flamecast-restate/src/shared-handlers.ts` | Shared VO handlers + handleAwaiting loop |
| `packages/flamecast-restate/src/ibm-agent-session.ts` | IBM ACP Virtual Object |
| `packages/flamecast-restate/src/zed-agent-session.ts` | Zed ACP Virtual Object |
| `packages/flamecast-restate/src/ibm-acp-adapter.ts` | IBM ACP adapter (HTTP) |
| `packages/flamecast-restate/src/zed-acp-adapter.ts` | Zed ACP adapter (stdio) |
| `packages/flamecast-restate/src/watch-agent-run.ts` | API SSE listener for IBM runs |
| `packages/flamecast-restate/test/restate-session-service.test.ts` | Existing test pattern to follow |
| `scripts/test-restate-e2e.sh` | E2E test script (for earlier integration, may need update) |
| `~/smithery/forge/apps/server/src/agent-object.ts` | Forge reference — thin VO pattern |
| `~/smithery/forge/packages/runtime/src/restate.ts` | Forge reference — runtime abstraction |

## 8. Forge Reference (Why It Matters)

Forge is Smithery's other agent project. Its Restate architecture is the reference pattern:
- VO is thin (94 lines, 4 handlers)
- Runtime abstraction decouples agent logic from Restate
- `sendEvent` shared handler is 3 lines
- No business logic in VO — delegate to helpers

Flamecast follows this pattern. The VOs delegate to adapters and shared helpers.

## 9. What's Next After Tests

1. **1f + 3c:** Write and run E2E tests for both VOs
2. **2a + 2b:** Wire pubsub event publishing + client SSE endpoint
3. **Demo:** Build a compelling demo showing durable agent orchestration (see `mono-9l05` and `mono-5i2b` for demo task context)
4. **4a:** SDD for refactoring Go session-host to ACP HTTP endpoints
5. **5a:** Remove old layers (~1,400 lines)

## 10. Beads Memory

Key memories stored:
- `project_restate_flamecast_sdd.md` — original Restate integration decisions
- `project_unified_acp_adapter.md` — two-protocol adapter design

Use `bd memories` to search, `bd show <id>` for task details.

## 11. Common Pitfalls

- **The coding agent tries to spin up Restate manually** — redirect to use `RestateTestEnvironment` from testcontainers
- **The coding agent puts streaming inside `ctx.run()`** — remind them: "ctx.run() doesn't support streaming per the Restate guide"
- **The coding agent polls inside `ctx.run()`** — redirect to awakeables
- **The coding agent creates one VO with protocol branching** — redirect to two separate VOs with shared handlers
- **Build breaks because of stale dist/** — run `pnpm --filter @flamecast/sdk build:package` before `npx tsc --noEmit` in the restate package
- **Restate binary not found** — `pnpm --filter @flamecast/session-host-go run postinstall` to rebuild Go binary
- **Restate data corrupted** — `rm -rf packages/flamecast-restate/restate-data/` and restart
- **Old Restate processes** — `lsof -i :18080` and kill zombies
