# SDD: Restate Control Plane for ACP Agent Orchestration

**Status:** Draft v10
**Author:** Gurdas Nijor
**Date:** 2026-03-31

## 1. Problem

Flamecast orchestrates black-box ACP agents. If the control plane crashes
mid-run, the run state is lost — LLM call results gone, awaiting state
unrecoverable, no record of what happened.

The Restate VO currently handles lifecycle (start/terminate/permissions) but
doesn't journal agent runs. To offer durable control-plane recovery, we need
to journal the ACP run lifecycle.

**Scope clarification:** This SDD covers durable *control-plane* recovery —
the VO's journal entries (prompt results, pause state, config changes) replay
deterministically. It does NOT cover full agent runtime recovery. Whether the
agent process survives depends on the compute surface (§4.3), not Restate.

## 2. Two protocols, one adapter

Two different protocols share the "ACP" name:

| | Zed ACP (Agent Client Protocol) | IBM ACP (Agent Communication Protocol) |
|---|---|---|
| **By** | Zed Industries | IBM / BeeAI (Linux Foundation) |
| **Transport** | JSON-RPC over stdio | REST over HTTP |
| **Focus** | IDE ↔ coding agent | Agent ↔ agent composition |
| **Ecosystem** | 32 agents (Codex, Claude, Gemini, Cursor, Copilot...) | Enterprise (BeeAI, LangChain) |

Flamecast supports both. A unified `AgentAdapter` interface abstracts protocol
differences. The VO calls the adapter without knowing which protocol is
underneath.

### 2.1 Adapter interface

```typescript
interface AgentAdapter {
  // --- Core lifecycle ---
  start(config: AgentStartConfig): Promise<SessionHandle>;
  cancel(session: SessionHandle): Promise<void>;
  close(session: SessionHandle): Promise<void>;

  // --- Streaming (API layer / client-direct, not journaled) ---
  prompt(session: SessionHandle, input: string | AgentMessage[]): AsyncIterable<AgentEvent>;
  resume(session: SessionHandle, payload: unknown): AsyncIterable<AgentEvent>;

  // --- Sync (VO handler, inside ctx.run(), journaled) ---
  // Block until the agent completes or enters "awaiting".
  // Only promptSync and resumeSync need sync variants — everything else
  // already returns a single Promise value that ctx.run() can journal.
  promptSync(session: SessionHandle, input: string | AgentMessage[]): Promise<PromptResult>;
  resumeSync(session: SessionHandle, runId: string, payload: unknown): Promise<PromptResult>;

  // --- Config (journaled via ctx.run() directly — no sync variant needed) ---
  getConfigOptions(session: SessionHandle): Promise<ConfigOption[]>;
  setConfigOption(session: SessionHandle, configId: string, value: string): Promise<ConfigOption[]>;
}
```

`steer` is NOT an adapter method — it's a VO handler that composes
`cancel()` → `setConfigOption()` → `promptSync()` as separate `ctx.run()`
steps (see §5.6).

### 2.2 Types

```typescript
interface PromptResult {
  status: "completed" | "awaiting" | "failed" | "cancelled";
  output?: AgentMessage[];
  awaitRequest?: unknown;  // present when status === "awaiting"
  runId?: string;          // for resumeSync / client SSE subscription
  error?: string;          // present when status === "failed"
}

type AgentEvent =
  | { type: "text"; text: string; role: "assistant" | "thinking" }
  | { type: "tool"; toolCallId: string; title: string; status: "pending" | "running" | "completed" | "failed"; input?: unknown; output?: unknown }
  | { type: "pause"; request: unknown }
  | { type: "complete"; reason: "end_turn" | "cancelled" | "failed" | "max_tokens"; output?: AgentMessage[] }
  | { type: "error"; code: string; message: string };

interface AgentMessage {
  role: "user" | "assistant";
  parts: Array<{ contentType: string; content?: string; contentUrl?: string }>;
}

interface AgentInfo {
  name: string;
  description?: string;
  capabilities?: Record<string, unknown>;
}

interface SessionHandle {
  sessionId: string;
  protocol: "zed" | "ibm";
  agent: AgentInfo;
  connection: {
    url?: string;           // HTTP URL for IBM / containerized Zed agents
    pid?: number;           // Local process PID (non-durable — dies on restart)
    containerId?: string;   // Docker container ID (may survive restart)
    sandboxId?: string;     // E2B sandbox ID (may survive restart)
  };
}

interface AgentStartConfig {
  agent: string;           // Binary path (Zed) or base URL + agent name (IBM)
  cwd?: string;            // Working directory
  sessionId?: string;      // Explicit session ID
  env?: Record<string, string>;
  callbacks?: AgentCallbacks;  // For Zed's agent→client requests (optional)
}
```

`SessionHandle` is stored in VO state via `ctx.set("session", handle)`. On
replay, the VO uses `connection.url` / `connection.containerId` /
`connection.sandboxId` to reconnect (if the compute surface survived) or
re-provision (if it didn't). `connection.pid` is non-durable — local processes
die on server restart.

### 2.3 How each adapter works

**Zed ACP Adapter (stdio):**
```
start:       spawn(command, args, { stdio: "pipe" }) → initialize → session/new → SessionHandle
promptSync:  session/prompt (blocks until response)
prompt:      session/prompt + yield session/update notifications as AgentEvent
pause:       agent sends request_permission → yield PauseEvent → adapter blocks JSON-RPC response
resume:      return permission response → unblocks JSON-RPC → agent continues
cancel:      session/cancel notification
close:       kill subprocess
```

**IBM ACP Adapter (HTTP):**
```
start:          GET /agents/{name} → store baseUrl → SessionHandle
createRun:      POST /runs { mode: "async" } → returns { runId } immediately
awaitRun:       poll GET /runs/{runId} until terminal → return PromptResult
promptSync:     createRun + awaitRun composed (for simple callers)
prompt:         POST /runs { mode: "stream" } → yield SSE events as AgentEvent
pause:          run enters "awaiting" status → awaitRun returns PromptResult with awaitRequest
resume:         POST /runs/{id} { await_resume, mode: "async" or "stream" }
cancel:         POST /runs/{id}/cancel
close:          no-op (stateless HTTP)
```

The VO calls `createRun` and `awaitRun` as separate `ctx.run()` steps so the
`runId` is visible immediately for client SSE subscription (see §5.2).

### 2.4 Small journaling surface

Regardless of protocol, the adapter's mutation surface reduces to 3 durable
operations:

| Adapter method | Restate primitive | IBM ACP | Zed ACP |
|---|---|---|---|
| `createRun()` | `ctx.run("create-run")` — journal runId | `POST /runs` (async) | N/A (bundled in promptSync) |
| — | `ctx.awakeable()` — suspend until terminal | SSE listener resolves | N/A |
| `promptSync()` | single `ctx.run()` | N/A (VO uses create+awakeable) | `session/prompt` |
| `resumeSync()` | `resolveAwakeable()` + create+awakeable | `POST /runs/{id}` (async) | return perm response |
| `cancel()` | `ctx.run()` — journal cancellation | `POST /runs/{id}/cancel` | `session/cancel` |

For IBM ACP, the VO splits execution into create (journaled) + awakeable
(zero compute suspend). An external SSE listener watches the agent and resolves
the awakeable on terminal state — no polling inside `ctx.run()`. For Zed ACP,
`promptSync` is a single step (stdio blocks until done, runId = sessionId).

Read-only operations (`GET /agents`, `GET /runs/{id}`, `GET /runs/{id}/events`,
`GET /session/{id}`, `GET /ping`) pass through without journaling.

### 2.5 Streaming vs journaling — single execution, two consumers

Per the [Restate integration guide](https://docs.restate.dev/ai/sdk-integrations/integration-guide):
*"ctx.run() blocks do not support streaming."*

**The VO is the single authoritative execution path.** Streaming is derived
from the same run, not a separate execution.

**IBM ACP:** The VO creates the run via `ctx.run("create-run")`, journaling
the `runId`, then suspends on an awakeable (zero compute). The `runId` is
published to pubsub immediately — clients can subscribe to
`GET /runs/{runId}/events` SSE for live tokens. An external SSE listener
(in the Flamecast API layer) watches the agent's event stream for terminal
states (`run.completed`, `run.awaiting`, `run.failed`) and resolves the
awakeable when one arrives. The same listener forwards `message.part` tokens
to pubsub for client UI. One execution, zero polling, zero compute during
the wait.

**Zed ACP:** `session/prompt` blocks on stdio and emits `session/update`
notifications on the same pipe during execution. The adapter collects the
final result for `ctx.run()` journaling. Token notifications cannot be
published to pubsub from inside `ctx.run()` (no Restate context access). For
Zed agents, real-time token streaming is only available if the client connects
to the session-host WebSocket directly — the VO path is sync-only.

**Key invariant:** The VO never starts a second execution. The client consumes
the agent's own SSE (IBM, by `runId`) or the session-host's WebSocket (Zed),
both referenced by the same run that the VO tracks.

## 3. Architecture

Two protocol-specific VOs, each implementing its protocol natively. Shared
handlers (resume, status, webhooks, cleanup) are defined once and spread in.

```
                    ┌─────────────────────────────┐
                    │   API layer routes by        │
                    │   agent template protocol    │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                                 ▼
   ┌─────────────────────┐         ┌────────────────────────┐
   │  IbmAgentSession VO │         │  ZedAgentSession VO    │
   │  (create + awakeable)│         │  (blocking promptSync) │
   │                      │         │                        │
   │  runAgent:           │         │  runAgent:             │
   │   ctx.run(createRun) │         │   ctx.run(promptSync)  │
   │   → publish runId    │         │   → result immediate   │
   │   → awakeable()      │         │                        │
   │   → SUSPEND          │         │  Needs long inactivity │
   │   → SSE listener     │         │  timeout config        │
   │     resolves         │         │                        │
   │                      │         │                        │
   │  ...sharedHandlers   │         │  ...sharedHandlers     │
   └──────────┬───────────┘         └──────────┬─────────────┘
              │                                 │
              ▼                                 ▼
   ┌─────────────────────┐         ┌────────────────────────┐
   │  IbmAcpAdapter       │         │  ZedAcpAdapter          │
   │  HTTP fetch           │         │  stdio JSON-RPC         │
   └──────────┬───────────┘         └──────────┬─────────────┘
              │                                 │
              ▼                                 ▼
   Remote HTTP Agent              Local/Docker/E2B subprocess
```

**Benefits of two VOs:**
- No protocol branching inside handlers — each VO is pure and small
- Different Restate service configs per VO (Zed needs long inactivity timeout, IBM doesn't)
- Shared handlers defined once, spread into both
- `handleAwaiting` loop is shared — both protocols use awakeables for pause/resume
- API layer routes to the right VO based on agent template `protocol` field

### 3.1 Transport: REST + SSE, not WebSockets

All client-facing control-plane transport uses REST (actions) and SSE (events).
WebSockets are used only for terminal PTY byte streaming and Zed agent token
streaming, both of which stay with the session-host.

**Why not WebSockets for the control plane:**

1. **Restate pubsub IS SSE** — using WebSockets means maintaining separate
   real-time infrastructure alongside Restate. SSE unifies the event path.
2. **The multi-session WS RFC was built and reverted** — PRs #79/#80 added
   multiplexed WebSockets, reverted in PR #90 because the control plane must
   be stateless for Vercel deployment. WebSockets require stateful servers.
3. **Durability for free** — WebSocket messages are fire-and-forget (the
   existing EventBus ring buffer exists solely to paper over this). Restate
   pubsub provides offset-based replay natively. No ring buffer, no sequence
   counters.
4. **ACP (IBM) is REST+SSE natively** — the protocol uses REST for actions and
   SSE for streaming. No WebSocket in the IBM ACP spec.
5. **Built-in reconnection** — SSE has native `Last-Event-ID`. WebSocket
   requires custom reconnect + replay logic.

**Transport split:**

| Transport | Surface | Use case |
|---|---|---|
| **REST** (Restate ingress) | Control-plane actions | `POST /runs`, resume, cancel, session CRUD |
| **SSE** (Restate pubsub) | Control-plane events | run.awaiting, run.completed, message.completed |
| **SSE** (IBM ACP agent) | Token streaming | `GET /runs/{runId}/events` — client subscribes by runId |
| **WebSocket** (session-host) | Zed token streaming + Terminal PTY | Bidirectional byte streaming |

This eliminates ~640 lines of WebSocket infrastructure (hub, EventBus ring
buffer, channel routing, WS control message parsing, multi-session adapter).

### 3.2 What the VOs do (durable control plane)

Each VO implements its protocol's run pattern natively:

- **IbmAgentSession:** `ctx.run("create-run")` journals `runId`, then
  `ctx.awakeable()` suspends (zero compute). API SSE listener resolves on
  terminal state. No long-blocking steps.
- **ZedAgentSession:** `ctx.run("prompt")` blocks until the agent responds.
  Single step, needs increased inactivity timeout.

**Both VOs share:**
- **Pause/resume** — `handleAwaiting` loop with generation counter (§5.3)
- **Mid-turn steering** — `steerAgent` composes cancel → config → re-prompt
- **Control-plane events** — run state transitions published to Restate pubsub
- **Lifecycle state** — session handle, config options, generation counter

### 3.3 What the VOs do NOT do

- **Protocol translation** — each adapter handles its own protocol natively.
- **Agent internals** — the agent's tool loop, LLM calls, and internal state are opaque.
- **Token streaming** — clients consume this from the API SSE listener (IBM) or session-host WebSocket (Zed). The VO publishes the `runId` but doesn't relay tokens.
- **Subprocess management** — handled by the Zed adapter or not needed (IBM).
- **Terminal PTY** — bidirectional byte streaming stays with the session-host over WebSocket.
- **Agent runtime recovery** — whether the agent process survives depends on the compute surface (§4.3), not the VO.

## 4. Execution topology

The adapter interface is about **communication**. Where the agent process runs
is a separate concern — the **compute surface**.

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Restate VO Handlers                                │
│               (run in Flamecast server)                             │
│                                                                     │
│  IbmAgentSession:                 ZedAgentSession:                  │
│    ctx.run("create-run")            ctx.run("prompt",               │
│    → awakeable() suspend              adapter.promptSync())         │
│    → SSE listener resolves                                          │
│                                                                     │
│  The VOs are the CONTROL PLANE. They don't run agents.              │
│  They send messages to wherever the agent is running.               │
└──────────────┬──────────────────────────────┬───────────────────────┘
               │                              │
     ┌─────────▼─────────┐         ┌─────────▼─────────┐
     │  Zed ACP (stdio)  │         │  IBM ACP (HTTP)    │
     │  AgentAdapter      │         │  AgentAdapter      │
     └─────────┬─────────┘         └─────────┬─────────┘
               │                              │
               │ stdio pipes                  │ HTTP fetch
               │                              │
     ┌─────────▼─────────────────────────────▼───────────────────────┐
     │                     COMPUTE SURFACE                            │
     │                  (where agents run)                            │
     │                                                                │
     │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
     │  │  Local    │  │  Docker  │  │   E2B    │  │ Remote HTTP   │ │
     │  │ Process   │  │Container │  │ Sandbox  │  │   Server      │ │
     │  │          │  │          │  │          │  │               │ │
     │  │ stdio    │  │ stdio    │  │ stdio    │  │ HTTP (native) │ │
     │  │ (direct) │  │ (via     │  │ (via     │  │ (no bridge)   │ │
     │  │          │  │ session- │  │ session- │  │               │ │
     │  │          │  │  host)   │  │  host)   │  │               │ │
     │  └──────────┘  └──────────┘  └──────────┘  └───────────────┘ │
     └───────────────────────────────────────────────────────────────┘
```

### 4.1 Execution models

#### A. Local Process (Zed ACP, stdio)

```
Flamecast server (Node.js)
  └─ VO handler
       └─ ZedAcpAdapter.start()
            └─ child_process.spawn("codex", ["--acp"], { stdio: "pipe" })
                 ├─ stdin  ← JSON-RPC requests (prompt, cancel)
                 └─ stdout → JSON-RPC responses + notifications (events)
```

- **Who spawns:** The adapter, inside the VO handler
- **Where it runs:** Same machine as Flamecast server
- **Lifecycle:** Lives as long as the session. Killed on close().
- **Agents:** codex, claude, pi, gemini, cursor, copilot, opencode, kiro, etc.
- **Limitation:** Process tied to the Flamecast server. If server restarts, process dies.

#### B. Docker Container (Zed ACP, stdio via session-host bridge)

```
Flamecast server
  └─ VO handler
       └─ ctx.run("spawn-container", () => docker.createContainer(image))
            │  Returns: containerUrl = http://container-ip:9000
       └─ ZedAcpAdapter.start({ url: containerUrl })
            └─ Docker Container
                 ├─ session-host (thin relay, ~200 lines)
                 │    ├─ HTTP :9000
                 │    └─ Spawns agent subprocess with stdio
                 └─ Agent process (codex, claude, etc.)
```

- **Who spawns:** VO handler calls Docker API via `ctx.run()` (journaled)
- **Session-host role:** Thin relay only — spawn process, bridge stdio↔HTTP. No permissions, no queue, no callbacks.
- **Advantage:** Isolated environment. Setup scripts install dependencies.

#### C. E2B Sandbox (Zed ACP, stdio via session-host bridge)

Same as Docker but using E2B's managed sandbox infrastructure.

```
Flamecast server
  └─ VO handler
       └─ ctx.run("create-sandbox", () => e2b.createSandbox(template))
            │  Returns: sandboxUrl = https://sandbox-abc.e2b.dev
       └─ ZedAcpAdapter.start({ url: sandboxUrl })
            └─ E2B Sandbox
                 ├─ session-host (thin relay)
                 └─ Agent process
```

- **Who spawns:** VO handler calls E2B API via `ctx.run()` (journaled — replay skips creation)
- **Advantage:** No Docker on host. Pre-built templates. Auto-cleanup.

#### D. Remote HTTP Agent (IBM ACP, native HTTP)

```
Flamecast server
  └─ VO handler
       └─ IbmAcpAdapter.start({ url: "https://my-agent.fly.dev" })
            │  HTTP fetch (POST /runs, GET /runs/{id}, SSE)
            └─ Remote Agent Server (any language, any framework)
```

- **Who spawns:** Nobody — agent is pre-deployed by the user
- **Session-host:** Not needed. Agent speaks HTTP natively.
- **Advantage:** Simplest model. No stdio, no bridge.

#### E. Remote Zed ACP Agent (future)

Zed ACP is adding remote transport (HTTP/WebSocket). When available, no
session-host needed — agent speaks Zed ACP over WebSocket directly.

### 4.2 Agent summary

| Agent | Protocol | Compute surface | Bridge needed? |
|---|---|---|---|
| `codex --acp` | Zed (stdio) | Local process | No — direct stdio |
| `claude --acp` | Zed (stdio) | Local process | No — direct stdio |
| `gemini --acp` | Zed (stdio) | Local process | No — direct stdio |
| Any Zed ACP agent in Docker | Zed (stdio) | Docker container | Yes — session-host |
| Any Zed ACP agent in E2B | Zed (stdio) | E2B sandbox | Yes — session-host |
| BeeAI / LangChain / custom agent | IBM (HTTP) | Remote server | No — native HTTP |
| Python agent (acp-sdk) | IBM (HTTP) | Remote server or Docker | No — serves /runs over HTTP |
| Go / Rust / Java agent | IBM (HTTP) | Remote server or Docker | No — any language that serves HTTP |
| Python agent (Zed stdio) | Zed (stdio) | Local or Docker | spawn("python", ["agent.py", "--acp"]) |
| Any Zed ACP agent (remote, future) | Zed (WS) | Remote server | No — native WS |

### 4.3 Restate durability per compute surface

The VO provides durable control-plane state (prompt results, pause state,
config changes). Whether the agent process itself survives depends on the
compute surface:

| Model | ctx.run("spawn") | ctx.run("prompt") | Awakeable (pause) | Agent process on replay |
|---|---|---|---|---|
| Local process | Journals PID (non-durable) | Journals response | Suspends handler | **Dead.** Re-spawn + re-feed history. |
| Docker | Journals container ID | Journals response | Suspends handler | **May survive.** Check health, reconnect or re-create. |
| E2B | Journals sandbox ID | Journals response | Suspends handler | **May survive.** Reconnect via stored ID. |
| Remote HTTP | N/A (pre-deployed) | Journals response | Suspends handler | **Unaffected.** Return cached response. |

## 5. Design

### 5.1 Agent lifecycle → Restate mapping

```
Agent State      Restate Primitive         IBM ACP              Zed ACP
───────────      ─────────────────         ────────             ───────
started     →    ctx.run("start")          POST /runs           spawn + initialize
processing  →    ctx.awakeable() suspend   awakeable (SSE)      session/prompt blocks
paused      →    ctx.awakeable() suspend   run.awaiting         request_permission
resumed     →    resolveAwakeable()        POST /runs/{id}      return perm response
completed   →    ctx.run() returns         run.completed        prompt returns
failed      →    TerminalError             run.failed           error response
cancelled   →    ctx.run("cancel")         POST /cancel         session/cancel
```

### 5.2 VO structure: shared handlers + two protocol VOs

```typescript
// ── Shared handlers — defined once, spread into both VOs ──────────

const sharedHandlers = {
  resumeAgent: restate.handlers.object.shared(
    { enableLazyState: true },
    async (ctx: restate.ObjectSharedContext, input: {
      awakeableId: string;
      payload: unknown;
      generation: number;
    }) => {
      const pending = await ctx.get<{ generation: number }>("pending_pause");
      if (!pending || pending.generation !== input.generation) {
        throw new restate.TerminalError("Stale resume — pause was cancelled or superseded");
      }
      ctx.resolveAwakeable(input.awakeableId, input.payload);
    },
  ),

  getStatus: restate.handlers.object.shared(
    { enableLazyState: true },
    async (ctx: restate.ObjectSharedContext) => ctx.get<SessionMeta>("meta"),
  ),

  getWebhooks: restate.handlers.object.shared(
    { enableLazyState: true },
    async (ctx: restate.ObjectSharedContext) => (await ctx.get<WebhookConfig[]>("webhooks")) ?? [],
  ),

  cleanup: async (ctx: restate.ObjectContext): Promise<void> => {
    ctx.clearAll();
  },
};


// ── IBM ACP VO — create + awakeable pattern ───────────────────────

const IbmAgentSession = restate.object({
  name: "IbmAgentSession",
  handlers: {
    ...sharedHandlers,

    runAgent: async (ctx: restate.ObjectContext, input: { text: string }) => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new IbmAcpAdapter();

      // Phase 1: Create run (journaled) — runId visible immediately
      const { runId } = await ctx.run("create-run", () =>
        adapter.createRun(session, input.text)
      );

      // Publish immediately — clients subscribe to agent SSE by runId
      publish(ctx, `session:${ctx.key}`, { type: "run.started", runId });

      // Phase 2: Suspend on awakeable — ZERO compute until terminal
      // API layer SSE listener resolves this when agent reaches terminal state
      const { id: awakeableId, promise } = ctx.awakeable<PromptResult>();
      ctx.set("pending_run", { awakeableId, runId });

      const result = await promise;
      ctx.clear("pending_run");

      return handleResult(ctx, adapter, session, result);
    },

    cancelAgent: async (ctx: restate.ObjectContext) => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      await ctx.run("cancel", () => new IbmAcpAdapter().cancel(session));
      ctx.clear("pending_pause");
      ctx.clear("pending_run");
      return { cancelled: true };
    },

    steerAgent: async (ctx: restate.ObjectContext, input: {
      newText: string; mode?: string; model?: string;
    }) => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new IbmAcpAdapter();

      await ctx.run("cancel", () => adapter.cancel(session));
      if (input.mode) {
        await ctx.run("set-mode", () => adapter.setConfigOption(session, "mode", input.mode!));
      }
      if (input.model) {
        await ctx.run("set-model", () => adapter.setConfigOption(session, "model", input.model!));
      }

      // Re-create run (same create + awakeable pattern)
      const { runId } = await ctx.run("create-run", () =>
        adapter.createRun(session, input.newText)
      );
      publish(ctx, `session:${ctx.key}`, { type: "run.started", runId });

      const { id: awakeableId, promise } = ctx.awakeable<PromptResult>();
      ctx.set("pending_run", { awakeableId, runId });

      const result = await promise;
      ctx.clear("pending_run");

      return handleResult(ctx, adapter, session, result);
    },
  },
});


// ── Zed ACP VO — single blocking prompt ───────────────────────────

const ZedAgentSession = restate.object({
  name: "ZedAgentSession",
  handlers: {
    ...sharedHandlers,

    runAgent: async (ctx: restate.ObjectContext, input: { text: string }) => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new ZedAcpAdapter();

      // Single ctx.run — blocks until agent responds.
      // Needs increased inactivity timeout for long-running agents.
      const result = await ctx.run("prompt", () =>
        adapter.promptSync(session, input.text)
      );

      return handleResult(ctx, adapter, session, result);
    },

    cancelAgent: async (ctx: restate.ObjectContext) => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      await ctx.run("cancel", () => new ZedAcpAdapter().cancel(session));
      ctx.clear("pending_pause");
      return { cancelled: true };
    },

    steerAgent: async (ctx: restate.ObjectContext, input: {
      newText: string; mode?: string; model?: string;
    }) => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new ZedAcpAdapter();

      await ctx.run("cancel", () => adapter.cancel(session));
      if (input.mode) {
        await ctx.run("set-mode", () => adapter.setConfigOption(session, "mode", input.mode!));
      }
      if (input.model) {
        await ctx.run("set-model", () => adapter.setConfigOption(session, "model", input.model!));
      }

      const result = await ctx.run("re-prompt", () =>
        adapter.promptSync(session, input.newText)
      );

      return handleResult(ctx, adapter, session, result);
    },
  },
});


// ── Shared result handler — both VOs use this ─────────────────────

async function handleResult(
  ctx: restate.ObjectContext,
  adapter: AgentAdapter,
  session: SessionHandle,
  result: PromptResult,
): Promise<PromptResult> {
  if (result.status === "completed") {
    ctx.set("lastRun", result);
    publish(ctx, `session:${ctx.key}`, { type: "complete", result });
    return result;
  }
  if (result.status === "awaiting") {
    return await handleAwaiting(ctx, adapter, session, result);
  }
  if (result.status === "failed") {
    throw new restate.TerminalError(`Agent run failed: ${result.error}`);
  }
  return result;
}
```

**API layer SSE listener (IBM ACP only, outside Restate):**

```typescript
// Flamecast API starts this when IbmAgentSession publishes run.started.
// Runs outside the VO — no Restate context needed.
async function watchAgentRun(agentUrl: string, runId: string, awakeableId: string, topic: string) {
  for await (const event of agentSSE(`${agentUrl}/runs/${runId}/events`)) {
    // Forward tokens to pubsub for client UI
    if (event.type === "message.part") {
      pubsub.publish(topic, event);
    }
    // Resolve awakeable on terminal state — resumes the VO handler
    if (["run.completed", "run.awaiting", "run.failed"].includes(event.type)) {
      await restateClient.resolveAwakeable(awakeableId, event.run as PromptResult);
      break;
    }
  }
}
```

### 5.3 Pause → awakeable loop

An agent can pause multiple times within a single logical run (e.g.,
multi-step approval, multiple permission requests). The handler loops until
a terminal state. A generation counter prevents stale resumes after
cancel/steer.

```typescript
async function handleAwaiting(
  ctx: restate.ObjectContext,
  adapter: AgentAdapter,
  session: SessionHandle,
  result: PromptResult,
): Promise<PromptResult> {
  let currentResult = result;

  while (currentResult.status === "awaiting") {
    // Increment generation counter — prevents stale resumes
    const generation = ((await ctx.get<number>("generation")) ?? 0) + 1;
    ctx.set("generation", generation);

    // Publish the pause request so clients know what's needed
    publish(ctx, `session:${ctx.key}`, {
      type: "pause",
      request: currentResult.awaitRequest,
      generation,
    });

    // Store awakeable ID so external systems can resolve it
    const { id: awakeableId, promise } = ctx.awakeable<unknown>();
    ctx.set("pending_pause", {
      awakeableId,
      runId: currentResult.runId,
      request: currentResult.awaitRequest,
      generation,
    });

    // SUSPEND — zero compute until client resumes
    const resumePayload = await promise;

    ctx.clear("pending_pause");

    // Capture values before entering ctx.run() — the closure must not
    // reference the mutable `currentResult` variable, which could differ
    // between the first execution and a replay.
    const runId = currentResult.runId;

    // Journal the resumption
    currentResult = await ctx.run("resume", () =>
      adapter.resumeSync(session, runId, resumePayload)
    );
  }

  ctx.set("lastRun", currentResult);
  publish(ctx, `session:${ctx.key}`, { type: "complete", result: currentResult });
  return currentResult;
}
```

### 5.4 Session config options

ACP (Zed) agents expose configurable session options that clients can change
at any time — including mid-turn.

| Category | Purpose | Example values |
|---|---|---|
| `mode` | Session mode | `ask`, `code`, `architect` |
| `model` | Model selector | `fastest`, `most-powerful`, specific model IDs |
| `thought_level` | Reasoning depth | Low, medium, high |
| `_custom` | Agent-defined | Anything with underscore prefix |

`getConfigOptions()` and `setConfigOption()` return `Promise<ConfigOption[]>`,
which `ctx.run()` can journal directly — no sync variant needed.

Note: `steer` is a VO handler, not an adapter method. It composes
`cancel()` → `setConfigOption()` → create/prompt as separate `ctx.run()`
steps. Both VOs implement it inline (§5.2). Reference:
[SMI-1660](https://linear.app/smithery/issue/SMI-1660/acp-steering).

### 5.5 SSE event streaming

Control-plane events flow through Restate pubsub. Token streaming is consumed
directly from the agent.

**Durable control-plane events (from VO):** Published after each `ctx.run()`
step returns. Survive restarts:
- `run.started` — published with `runId` so clients can subscribe to agent SSE
- `run.awaiting` / `pause` — published when the agent pauses for input
- `run.completed` / `run.failed` — published when the run reaches a terminal state
- `message.completed` — published with the full message content
- Session lifecycle events — `session.created`, `session.terminated`

**Token streaming:**
- **IBM ACP:** The API layer's SSE listener (§5.2) subscribes to
  `GET /runs/{runId}/events` on the agent server. It forwards `message.part`
  tokens to the same pubsub topic as durable events — so the client gets
  everything from one SSE subscription. The same listener resolves the VO's
  awakeable on terminal state.
- **Zed ACP:** Client connects to session-host WebSocket for real-time
  `session/update` notifications. The VO path is sync-only; tokens are only
  available via the session-host.

**On reconnect:** Client reconnects to Restate pubsub with `Last-Event-ID`.
Durable control-plane events replay. Token streams are ephemeral — the
`message.completed` event (durable) contains the full content.

### 5.6 Agent URL and adapter resolution

The VO resolves the adapter type and connection details from the
`SessionHandle` stored in VO state.

| Compute surface | Protocol | Adapter | Connection field |
|---|---|---|---|
| Local process | Zed (stdio) | `ZedAcpAdapter` | `connection.pid` (direct stdio) |
| Docker container | Zed (stdio) | `ZedAcpAdapter` | `connection.url` + `connection.containerId` |
| E2B sandbox | Zed (stdio) | `ZedAcpAdapter` | `connection.url` + `connection.sandboxId` |
| Remote HTTP server | IBM (HTTP) | `IbmAcpAdapter` | `connection.url` |

For non-remote agents, the VO's `startSession` handler spawns the runtime
via `ctx.run("spawn")` (journaled — no orphaned containers on crash) and
stores the connection details in `SessionHandle`.

## 6. Replay semantics

When a VO replays after a Restate restart:

**IbmAgentSession:**
1. `ctx.run("create-run")` → returns journaled `{ runId }` (no re-POST)
2. Run awakeable re-created with same ID
3. API layer re-subscribes to agent SSE and resolves awakeable
4. If `awaiting`: pause awakeable replayed from journal

**ZedAgentSession:**
1. `ctx.run("prompt")` → returns journaled `PromptResult` (no re-call)
2. If `awaiting`: awakeable re-created with same ID, generation counter restored
3. `ctx.run("resume")` → returns journaled result (no re-call)

**This is control-plane replay, not agent recovery.** The VO returns cached
results from the journal. The agent process is a separate concern:

- **Local process:** Dead after server restart. The VO has the journaled result
  for completed turns, but the process must be re-spawned for new turns.
- **Docker/E2B:** Container or sandbox may still be alive. The VO reconnects
  using `connection.containerId` / `connection.sandboxId` from `SessionHandle`.
- **Remote HTTP:** Unaffected. Agent is pre-deployed and stateless from the
  VO's perspective.

## 7. What goes away (vs current architecture)

| Component | ~Lines | Status |
|---|---|---|
| `RestateSessionService` | 200 | Removed — VO calls adapter directly |
| `RestateStorage` (SQL introspection) | 244 | Removed — VO state is authoritative |
| `ISessionService` interface | 40 | Removed — adapter replaces |
| `SessionService` (in-memory) | 280 | Removed — VO replaces |
| WebSocket hub + EventBus ring buffer | ~300 | Removed — Restate pubsub + SSE |
| WS control message parsing | ~150 | Removed — REST actions |
| WS channel routing / multi-session adapter | ~190 | Removed — pubsub topic-per-session |
| Session-host (for ACP HTTP agents) | — | **Not needed** — VO calls HTTP directly |
| Runtime providers (for ACP HTTP agents) | — | Simplified — just need agent URL |
| Proxy chain | — | Eliminated — VO is the only intermediary |

**~1,400+ lines eliminated** across session service, storage, and WebSocket infrastructure.

**Session-host stays for two cases:**
1. **stdio agents** — local subprocesses and containerized agents that need
   stdio↔HTTP bridging.
2. **Terminal PTY + Zed token streaming** — bidirectional byte streaming at
   keystroke frequency, plus real-time `session/update` notifications for Zed
   agents.

## 8. RFC alignment

### 8.1 Unified Runtime RFC

The RFC's `spawn` + `setup` + `packages` template model works directly with
the adapter. Runtime provisioning happens **before** `adapter.start()` — the
runtime provisions the environment, then the adapter connects.

| RFC Tier | Adapter Compute Surface |
|---|---|
| Zero config (local) | Local process — `child_process.spawn()`, direct stdio |
| Zero config (docker) | Docker — runtime infers image, session-host bridges stdio↔HTTP |
| Light config (packages) | Docker — same, with apt-get before setup |
| Full control (Dockerfile) | Docker — custom image, same adapter interface |
| Remote HTTP (new) | Not in RFC — adapter calls agent URL directly, no spawn/setup |

The adapter adds a compute surface the RFC didn't envision: **remote HTTP
agents** that don't need spawn/setup/packages.

### 8.2 Runtime Lifecycle RFC

**Subsumed by the VO.** Instance lifecycle moves into VO handlers:

| RFC concept | Restate equivalent |
|---|---|
| Start instance | `ctx.run("start-runtime", () => docker.createContainer(...))` — journaled, no orphans |
| Stop instance | `ctx.run("stop-runtime", () => docker.removeContainer(...))` — journaled |
| Pause instance | VO handler suspends via `ctx.sleep()` or `ctx.awakeable()` |
| Resume instance | Restate replays journal, reconnects via `SessionHandle.connection` |
| Instance recovery | Restate journal replay — deterministic, no health probes |
| `runtime_instances` table | VO state (`ctx.get/set`) — single source of truth |

Container creation inside `ctx.run()` means **no orphaned containers on crash**.

### 8.3 Queue Management RFC

**Replaced by Restate's VO inbox.** The VO's exclusive handler provides
prompt serialization natively:

| RFC concept | Restate equivalent |
|---|---|
| Prompt queue (FIFO) | VO exclusive handler — calls queue automatically |
| Queue pause | Handler awaits an awakeable — nothing dequeues |
| Queue resume | Resolve the awakeable — next queued call proceeds |
| Queue cancel (single) | `ctx.cancel(invocationId)` on the queued invocation |
| Queue clear | Cancel all pending invocations for the VO key |
| Queue state query | Restate admin: `SELECT * FROM sys_inbox WHERE service_key = '{sessionId}'` |

No custom queue data structure needed.

### 8.4 Terminal Sessions RFC

**Unchanged — stays with session-host over WebSocket.**

| Terminal concern | Where it lives |
|---|---|
| PTY creation/resize/kill | Session-host (Go binary or container process) |
| Input streaming (keystrokes) | WebSocket — client → session-host |
| Output streaming (bytes) | WebSocket — session-host → client |
| Terminal ring buffer (100KB) | Session-host memory |
| Terminal lifecycle events | VO pubsub (terminal.created, terminal.exited) — durable |

### 8.5 Summary

| RFC | Status |
|---|---|
| **Unified Runtime** | Aligned — `spawn`/`setup`/`packages` work with adapter. Adds remote HTTP. |
| **Runtime Lifecycle** | Subsumed — VO handles lifecycle via `ctx.run()`. No separate manager. |
| **Queue Management** | Replaced — VO exclusive handler + inbox = durable queue for free. |
| **Terminal Sessions** | Unchanged — data plane, stays with session-host over WebSocket. |

## 9. Implementation plan

### Phase 1: Shared handlers + IbmAgentSession VO

- Implement `AgentAdapter` interface (§2.1), shared handlers, `handleAwaiting`
- Implement `IbmAcpAdapter`: `createRun` → `POST /runs` (async mode)
- Implement `IbmAgentSession` VO with create + awakeable pattern (§5.2)
- Implement API layer SSE listener (`watchAgentRun`) that resolves awakeable
  and forwards `message.part` tokens to pubsub
- Test with a Python echo agent from `acp-sdk`

### Phase 2: SSE event streaming + client integration

- Publish durable control-plane events from VO to Restate pubsub
- API listener forwards `message.part` tokens to same pubsub topic
- Client subscribes to single SSE endpoint via pubsub
- Verify `Last-Event-ID` reconnection behavior

### Phase 3: ZedAgentSession VO

- Implement `ZedAcpAdapter` wrapping stdio JSON-RPC
- Implement `ZedAgentSession` VO with blocking `promptSync` pattern (§5.2)
- Configure increased Restate inactivity timeout for `ZedAgentSession` service
- `promptSync()` calls `conn.Prompt()` and blocks until response
- `pause` maps `request_permission` to `pause` event, blocks JSON-RPC response
- Token streaming via session-host WebSocket (client-direct, not VO)
- Test with local `codex --acp` and `claude --acp`

### Phase 4: Session-host as thin ACP bridge (separate SDD)

Refactoring the Go session-host from Flamecast-specific HTTP to an
ACP-compliant HTTP surface for containerized Zed agents. Separate SDD:

- ACP endpoint mapping (`POST /runs` → spawn + prompt)
- Run state machine in Go
- SSE event emission
- Backward compat during migration

Until Phase 4, containerized Zed agents use the existing session-host path.

### Phase 5: Eliminate intermediary layers

- Remove `ISessionService`, `RestateSessionService`, `SessionService`
- Remove `RestateStorage`, WebSocket hub, EventBus ring buffer
- Flamecast API talks to VO directly via Restate ingress client
- ~1,400+ lines eliminated

## 10. Open questions

1. **Long-running Zed ACP sync calls** — The VO calls `adapter.promptSync()`
   inside `ctx.run()` for Zed agents. `session/prompt` blocks for the entire
   turn. Restate's inactivity timeout must be increased for Zed agents. IBM ACP
   is not affected — it uses create + awakeable (zero compute during the wait).

2. **Pubsub throughput for token streaming** — The API layer's SSE listener
   forwards `message.part` tokens to pubsub. High-frequency token events could
   stress pubsub. Fallback: forward tokens to a separate non-pubsub SSE
   endpoint, only publish durable events to pubsub.

3. **SSE listener reliability** — The API layer SSE listener (§5.2) is the
   bridge between the agent's event stream and the VO's awakeable. If it
   crashes, the awakeable stays unresolved. Mitigations: (a) run the listener
   with `waitUntil` so it outlives the HTTP response, (b) add a timeout
   awakeable that auto-fails after N minutes, (c) on API restart, re-subscribe
   to in-progress runs by checking `pending_run` state on active VOs.

3. **Zed ACP sync semantics in container** — When the Zed adapter talks to a
   containerized agent via session-host HTTP bridge, `promptSync()` must block
   until the JSON-RPC `session/prompt` response arrives. Verify the session-host
   HTTP endpoint blocks correctly (it does today via `conn.Prompt()` blocking).

### Resolved

- **Local process replay** — Accepted limitation. Local processes die on server
  restart. Completed turns replay from journal (control-plane state preserved).
  In-flight turn is lost. Push users to Docker/E2B/remote for production.
- **Multiple awaiting cycles** — §5.3 handles this with a loop + generation
  counter. Each cycle is a separate awakeable.
- **Timeout on awaiting** — Use `awakeable.promise.orTimeout(timeoutMs)`. On
  timeout, call `adapter.cancel()` and transition to failed.
- **Sync mode fallback** — Zed ACP is inherently sync (`promptSync` in one
  `ctx.run()`). IBM ACP: `mode: "async"` + awakeable, SSE listener resolves
  on terminal state. No polling.
- **Agent callbacks (Zed-specific)** — Zed adapter handles callbacks directly
  (holds stdio pipes). IBM adapter: no callbacks (HTTP is stateless).
- **Zed ACP remote transport** — WIP in the spec. When it lands, eliminates
  the session-host for remote Zed ACP agents.
- **Stale resume after cancel/steer** — Generation counter (§5.3, §5.4)
  prevents resolving an awakeable from a superseded pause cycle.
- **Duplicate execution risk** — VO is single authoritative execution path
  (§2.5). Streaming consumers subscribe to the same `runId`, not a second run.

## 11. What's NOT in scope

- Journaling agent internals (LLM calls, tool executions inside the agent)
- Modifying the ACP protocol
- Token-level streaming durability (ephemeral, UI-only)
- Full agent runtime recovery (depends on compute surface, not VO)
- Re-running agents from checkpoints
- Multi-agent orchestration (single agent per session for now)
