# Architecture & Design Reference

## MVP Session Lifecycle Model

Session lifecycle state is intentionally **memory-backed rather than durable**. `SessionService` owns an in-memory registry of active session routing metadata (session → runtime/host/ws handle). This registry is **not** restart-safe or multi-instance-safe in MVP.

A control-plane restart may orphan active session hosts and lose routing state; recovery, reconciliation, and durable session handles are explicitly deferred.

Persisted storage holds only application data needed today (session records for the list view, agent templates). Live session coordination is an ephemeral runtime concern.

**Failure model:**

- Active sessions are lost on control-plane restart
- No restart recovery is guaranteed
- No multi-instance control plane is supported
- Event replay is best-effort, not a durability guarantee

**Future path:** extend SessionService with durable session handles (`runtime_name`, `host_url`, `websocket_url` persisted to DB), `recover()` startup reconciliation. The abstraction is shaped for this — additive, not a rewrite.

---

## Semantic Model

| Component          | Responsibility                                                                                                      | Runs in                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **ControlPlane**   | Hono HTTP API. Platform-agnostic via `export default app`.                                                          | Node, CF Worker, Vercel, Lambda — same code everywhere                            |
| **SessionService** | Orchestrates session lifecycle. Coordinates between Storage and Runtime. Dispatches events to handlers.             | Inside ControlPlane (per-request)                                                 |
| **Storage**        | Persists session records and agent templates. Not the source of truth for live session routing.                     | Postgres (Drizzle) — PGLite locally, Neon/Supabase deployed                       |
| **Runtime**        | "Where does the SessionHost run, and how do I reach it?" Ensures a host exists, forwards traffic, terminates hosts. | Interface in SDK. Implementations: LocalRuntime, RemoteRuntime, external packages |
| **SessionHost**    | Per-session stateful Node process. Owns agent process, ACP connection, WS server, file watcher.                     | Local child process, Fly VM, E2B sandbox — wherever the Runtime puts it           |
| **LocalRuntime**   | Spawns SessionHost child processes. In-process on Node; sidecar behind RemoteRuntime on serverless.                 | Node.js only                                                                      |

## Responsibility Map

| Module             | Owns                                                                          | Does NOT Own                                          |
| ------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| `SessionService`   | In-memory session registry, runtime dispatch, create/terminate coordination   | Agent process, ACP, events, filesystem, durable state |
| `FlamecastStorage` | Session records (list/detail views), agent templates                          | Live routing handles, event data, session recovery    |
| `Runtime`          | Ensuring a host exists, forwarding HTTP/WS, tearing it down                   | Session metadata, event persistence, agent behavior   |
| `SessionHost`      | Agent process, ACP connection, WS events, file watching, permission brokering | Session metadata persistence, control plane API       |
| `Flamecast`        | Hono app, constructor options, signal handling                                | Everything above — delegates to SessionService        |

---

## System Diagrams

**Local dev (single Node process):**

```
┌──────────────────────────────────────────────────┐
│            Node.js  (pnpm dev)                    │
│                                                   │
│  Hono app (@hono/node-server, port 3001)         │
│  SessionService                                   │
│  Storage (PGLite, embedded)                        │
│  LocalRuntime (in-process, child_process.spawn)   │
│       │                                           │
│       ├─ SessionHost (child process, port 60001)  │
│       ├─ SessionHost (child process, port 60002)  │
│       └─ ...                                      │
└──────────────────────────────────────────────────┘

Vite dev server (port 3000) ── proxies /api → :3001
Client WS connects directly to SessionHost ports
```

No Miniflare. No Alchemy. No Docker. No sidecar. One `node` process + Vite.

**Deployed (serverless control plane + remote session hosts):**

```
┌─────────────────────────────────────────────────────────────┐
│                      ControlPlane                            │
│           (CF Worker / Vercel / any serverless)              │
│                                                              │
│  ┌──────────────────┐    ┌────────────────────────────────┐ │
│  │  Hono API Routes │    │  SessionService                │ │
│  │  REST + WS proxy │───▶│  - create / terminate / list   │ │
│  └──────────────────┘    │  - dispatch to Runtime by name  │ │
│                          │  - in-memory session registry   │ │
│                          └──────┬──────────────┬──────────┘ │
│                                 │              │             │
│                     ┌───────────▼──┐    ┌──────▼──────────┐ │
│                     │   Storage    │    │ Runtime Registry │ │
│                     │  (Postgres)  │    │ { name: Runtime }│ │
│                     │  sessions    │    └────────┬─────────┘ │
│                     │  templates   │             │            │
│                     └──────────────┘             │            │
└─────────────────────────────┬────────────────────────────────┘
                              │
                  Runtime.fetchSession(id, req)
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
     ┌────────────┐  ┌──────────────┐  ┌────────────┐
     │LocalRuntime│  │ FlyRuntime   │  │ E2BRuntime │
     │  (sidecar) │  │ (ext. pkg)   │  │ (ext. pkg) │
     └─────┬──────┘  └──────┬───────┘  └─────┬──────┘
           ▼                ▼                 ▼
     ┌──────────────────────────────────────────────┐
     │              SessionHost                      │
     │         (per-session Node process)            │
     │                                               │
     │  HTTP: POST /start, /terminate, GET /health   │
     │  WS:   events, prompts, permissions           │
     │  Internal: child_process.spawn(agent)          │
     │           ACP over stdio                      │
     │           file watcher                        │
     └──────────────────────────────────────────────┘
```

---

## Interfaces

### Runtime

```typescript
interface Runtime<TConfig extends Record<string, unknown> = {}> {
  readonly configSchema?: ZodType<TConfig>;
  fetchSession(sessionId: string, request: Request): Promise<Response>;
  dispose?(): Promise<void>;
}
```

Intentionally minimal for MVP. May split into explicit lifecycle methods later.

### SessionHost HTTP Contract

```typescript
interface SessionHostStartRequest {
  command: string;
  args: string[];
  workspace: string;
  setup?: string;
}

interface SessionHostStartResponse {
  acpSessionId: string;
  hostUrl: string; // e.g., "http://localhost:60305"
  websocketUrl: string; // e.g., "ws://localhost:60305"
}

// POST /terminate — kills agent process, closes WS
// GET /health → { status: "idle" | "running", sessionId? }
```

### Typed Flamecast Constructor (SMI-1680 + SMI-1665)

```typescript
type RuntimeConfigFor<R extends Record<string, Runtime<any>>> = {
  [K in keyof R]: R[K] extends Runtime<infer C> ? { provider: K; setup?: string } & C : never;
}[keyof R];

interface SessionContext<R extends Record<string, Runtime<any>>> {
  id: string;
  agentName: string;
  runtime: Extract<keyof R, string>;
  spawn: AgentSpawn;
  startedAt: string;
}

interface FlamecastOptions<R extends Record<string, Runtime<any>>> {
  runtimes: R;
  storage?: FlamecastStorage;
  agentTemplates?: Array<{
    id: string;
    name: string;
    spawn: AgentSpawn;
    runtime: RuntimeConfigFor<R>;
  }>;
  handleSignals?: boolean;

  // Event handlers (tier 1 for MVP)
  onPermissionRequest?: (c: PermissionContext) => Promise<PermissionResponse | undefined>;
  onSessionEnd?: (c: SessionEndContext) => Promise<void>;

  // Event handlers (tier 2, fast follow)
  onAgentMessage?: (c: MessageContext) => Promise<void>;
  onError?: (c: ErrorContext) => Promise<void>;
}
```

---

## Open Questions

### When to add durable session state

Trigger: remote runtimes in use (Fly, E2B) where SessionHosts survive control plane restarts, or multi-instance control plane. Add `runtime_name`, `host_url`, `websocket_url` to sessions table + `recover()`.

### When to add event persistence

Deferred. The sidebar "0 entries" and reconnect replay are nice-to-haves, not required for MVP. When added, the callback URL approach (SessionHost POSTs events to control plane) is preferred over giving every SessionHost DB credentials.

### Local dev: Node-only vs Alchemy

Node-only for local dev. Alchemy for deployment. Keep `alchemy:dev` as optional for testing deployed-like stack locally.
