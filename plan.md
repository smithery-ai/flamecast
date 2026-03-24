# Alchemy Container Migration Plan

## Context

Flamecast currently has two separate provisioners (`localProvisioner` using `child_process.spawn`, `dockerProvisioner` using Docker API directly) plus PGLite fallback logic scattered in application code. Two custom Alchemy resources (`FlamecastDatabase`, `FlamecastRuntime`) replace all of this — using `this.scope.local` to pick the lightest-weight backend per environment. Local dev requires zero Docker.

**Goal**: One resource graph. `alchemy dev` = PGLite + bare Node bridge + Miniflare + Vite (zero Docker). `alchemy deploy` = PlanetScale + CF Container + CF Worker. No separate code paths in application code.

**Linear tickets**:
- [SMI-1673](https://linear.app/smithery/issue/SMI-1673) — Make runtime provisioning serverless-compatible (primary)
- [SMI-1677](https://linear.app/smithery/issue/SMI-1677) — Add workspace setup step to RuntimeProvider (folded into Phase 1)
- SMI-1676 — Wire runtime-bridge into build/dev scripts (superseded by Phase 7)

## System Topology

Two deployment planes, cleanly separated:

```
CONTROL PLANE (persistent, always running)
══════════════════════════════════════════
  Managed by: alchemy dev / alchemy deploy
  Lifecycle: always on

  ├─ Worker (Hono API)           — handles REST + session CRUD
  ├─ Database (PGLite / PS)      — session metadata, templates
  ├─ Frontend (Vite)             — React UI
  └─ SessionManager              — provisions/terminates data plane instances
                                   (control plane code ABOUT the data plane)

DATA PLANE (ephemeral, per-session)
═══════════════════════════════════
  Managed by: SessionManager at request time
  Lifecycle: created on "Start Agent", destroyed on "Terminate"

  └─ runtime-bridge instance     — one per session
       └─ agent process          — spawned by the bridge
```

### Naming Convention

All code that manages the data plane lives in the control plane. The naming should reflect this:

| Current | What it is | New name |
|---------|-----------|----------|
| `src/runtime/container-provider.ts` | Control plane's session provisioner | `src/flamecast/session-manager.ts` |
| `src/runtime/local.ts` (LocalRuntimeClient) | Control plane's local session manager | `src/flamecast/session-manager-local.ts` |
| `src/runtime/client.ts` (RuntimeClient) | Interface for session management | `SessionManager` interface |
| `RuntimeProvider` | Interface for provisioning bridges | `RuntimeProvisioner` (already exists, keep) |
| `DataPlaneBinding` | Abstraction over local/deployed bridge access | `DataPlaneBinding` |
| `packages/runtime-bridge/` | Actual data plane code | Keep as-is |
| `src/runtime/ws-server.ts` | WS server for in-process sessions | Stays (control plane WS handling) |

The `src/runtime/` directory contains control plane code about managing the data plane. Consider renaming to `src/session/` or moving into `src/flamecast/` during Phase 8 cleanup.

## Key Design Decisions

### D1: One bridge process per session

Each session gets its own bridge process (local) or container instance (deployed). The bridge is single-session: `/start` spawns one agent, `/terminate` kills it, `/health` shows one status. No session multiplexing.

### D2: FlamecastRuntime is a factory, not a singleton

The resource doesn't represent a single running bridge. It provisions the *capability* to create bridges:

- **Local**: Returns a "bridge manager" — an object that spawns a new `child_process` per `fetchSession()` call, tracking PIDs for cleanup on delete.
- **Deployed**: Returns a CF Container binding (DurableObjectNamespace) — Cloudflare routes each `.get(id).fetch()` to a separate container instance automatically.

Both modes expose the same interface to the container-provider: `fetchSession(sessionId, request) → Response`.

### D3: DataPlaneBinding abstraction

The SessionManager uses a uniform interface that hides local vs. deployed:

```typescript
interface DataPlaneBinding {
  fetchSession(sessionId: string, request: Request): Promise<Response>;
}
```

- **Local**: Bridge manager spawns per-session Node processes, routes fetch by sessionId
- **Deployed**: Wraps `binding.idFromName(sessionId).get(id).fetch(request)` (CF DurableObjectNamespace)

The SessionManager never knows which mode it's in.

### D4: No Exec for daemons — use child_process.spawn directly

Alchemy's `Exec` resource runs commands to completion. Bridge processes are long-lived daemons. FlamecastRuntime local mode uses `child_process.spawn` directly in the resource create handler, stores `{ pid, port }` in resource state for cleanup on delete.

### D5: PGLite runs inside the Worker (Miniflare) process

PGLite is an embedded WASM Postgres — no wire protocol, no connection string. The existing `createPsqlStorage()` already handles both modes: if `url` is provided → pg driver; if not → PGLite on disk. FlamecastDatabase local mode returns `{ connectionString: "" }` (empty), and the storage layer falls back to PGLite. No conditional logic needed in worker.ts — the existing storage factory handles it.

### D6: Local runtime binding via Miniflare service binding

In local dev, the Worker runs in Miniflare. The FlamecastRuntime resource starts a "bridge manager" HTTP server. Alchemy's Worker resource uses Miniflare's `serviceBindings` to inject `RUNTIME` as a service pointing at the bridge manager's port.

**The Worker never detects or selects the mode.** FlamecastRuntime returns a `DataPlaneBinding`-shaped object in both modes. In local mode, it wraps the service binding with sessionId-in-URL routing. In deployed mode, it wraps the DurableObjectNamespace with `idFromName`/`get`/`fetch`. The Worker just calls `env.RUNTIME.fetchSession(sessionId, request)` — same code path either way.

### D7: WebSocket routing — direct connection in both modes

In both local and deployed modes, the bridge's WebSocket is directly addressable:
- **Local**: Bridge listens on `localhost:<port>`, browser connects directly
- **Deployed**: CF Container exposes a public URL, browser connects directly

The `websocketUrl` returned from `/start` points at the bridge, not the Worker. The Worker never proxies WebSocket traffic. The existing `getWebsocketUrl()` → `snapshotSession` plumbing returns whatever URL the provider received from the bridge. (If CF Containers turn out NOT to be directly addressable, the Worker would need WS proxy logic — but investigate this early in Phase 0.)

## Architecture

```
┌──────────────────────────┬──────────────────────────┬─────────────────────────┐
│                          │   Local (alchemy dev)    │ Deployed (alchemy deploy)│
├──────────────────────────┼──────────────────────────┼─────────────────────────┤
│ FlamecastDatabase        │ PGLite on disk           │ PlanetScale + branch    │
│                          │ (embedded, no Docker)    │ (managed Postgres)      │
├──────────────────────────┼──────────────────────────┼─────────────────────────┤
│ FlamecastRuntime         │ Bridge manager process   │ CF Container            │
│                          │ (spawns per-session      │ (per-instance routing   │
│                          │  child processes)        │  by Cloudflare)         │
├──────────────────────────┼──────────────────────────┼─────────────────────────┤
│ Worker (control plane)   │ Miniflare                │ CF Worker               │
├──────────────────────────┼──────────────────────────┼─────────────────────────┤
│ Frontend                 │ Vite dev server           │ CF Pages / Vite         │
└──────────────────────────┴──────────────────────────┴─────────────────────────┘
```

## Target alchemy.run.ts (~20 lines)

```typescript
import alchemy from "alchemy";
import { Worker, Vite } from "alchemy/cloudflare";
import { FlamecastDatabase } from "./src/alchemy/database.js";
import { FlamecastRuntime } from "./src/alchemy/runtime.js";

const app = await alchemy("flamecast");

const db = await FlamecastDatabase("flamecast-db", {
  migrationsPath: "./src/flamecast/storage/psql/migrations",
});

const runtime = await FlamecastRuntime("flamecast-runtime", {
  bridgeEntry: "../runtime-bridge/dist/index.js",
  dockerfile: "../runtime-bridge/Dockerfile",
});

export const server = await Worker("flamecast-api", {
  entrypoint: "./src/worker.ts",
  bindings: {
    DATABASE_URL: db.connectionString,
    RUNTIME: runtime.binding,
  },
  url: true,
  dev: { port: 3001 },
});

export const client = await Vite("flamecast-client");
await app.finalize();
```

## Critical Files

| File | Role |
|------|------|
| `packages/flamecast/src/alchemy/database.ts` | NEW — FlamecastDatabase custom resource |
| `packages/flamecast/src/alchemy/runtime.ts` | NEW — FlamecastRuntime custom resource (factory pattern) |
| `packages/flamecast/alchemy.run.ts` | Rewrite to use custom resources (~20 lines) |
| `packages/runtime-bridge/src/index.ts` | Rewrite to HTTP-first (single-session, lazy spawn) |
| `packages/runtime-bridge/Dockerfile` | NEW — for deployed mode only |
| `packages/flamecast/src/flamecast/session-manager.ts` | NEW — SessionManager using DataPlaneBinding |
| `packages/flamecast/src/worker.ts` | Wire DATABASE_URL + RUNTIME bindings |
| `packages/flamecast/src/runtime/local.ts` | Current LocalRuntimeClient — sidecar branch exists (rename in Phase 8) |
| `packages/flamecast/src/flamecast/runtime-provider.ts` | Remove localProvisioner + dockerProvisioner |

## Phases

### Phase 0: Interface definitions + pre-work

Define the contracts upfront so subsequent phases can implement against them independently.

**0a. Bridge HTTP contract** (shared between Phase 1 and Phase 4):

The bridge (single-session data plane process) exposes:
- `POST /start` request: `{ command: string, args: string[], workspace: string, setup?: string }`
- `POST /start` response: `{ sessionId: string, websocketUrl: string, port: number }`
- `POST /terminate` request: empty body
- `GET /health` response: `{ status: "idle" | "running", sessionId?: string }`
- WebSocket upgrade at `/ws`

The bridge manager (local mode, multi-session router) exposes:
- `POST /sessions/:sessionId/start` → spawns a new bridge child process, forwards the request body, returns the bridge's `/start` response
- `POST /sessions/:sessionId/terminate` → forwards to the session's bridge, kills the child process
- `GET /sessions/:sessionId/health` → forwards to the session's bridge

The bridge manager's URL scheme encodes the sessionId in the path. The `DataPlaneBinding.fetchSession()` implementation for local mode rewrites the request URL from `/start` to `/sessions/:sessionId/start` before forwarding to the bridge manager.

**0b. DataPlaneBinding interface** (shared between Phase 3 and Phase 4):
```typescript
interface DataPlaneBinding {
  fetchSession(sessionId: string, request: Request): Promise<Response>;
}
```

Two implementations, both returned by FlamecastRuntime:
```typescript
// Local: bridge manager service binding
const localBinding: DataPlaneBinding = {
  async fetchSession(sessionId, request) {
    const url = new URL(request.url);
    url.pathname = `/sessions/${sessionId}${url.pathname}`;
    return managerService.fetch(new Request(url, request));
  }
};

// Deployed: CF Container (confirmed DO-style routing)
const deployedBinding: DataPlaneBinding = {
  async fetchSession(sessionId, request) {
    const id = containerBinding.idFromName(sessionId);
    return containerBinding.get(id).fetch(request);
  }
};
```

The Worker never selects an adapter — FlamecastRuntime returns the right DataPlaneBinding for the mode. The Worker receives `env.RUNTIME` which already IS the correct binding, wrapped by the Alchemy resource.

**0c. CF Container networking** — **RESOLVED**: CF Containers use Durable Object-style routing (`binding.idFromName(sessionId).get(id).fetch(request)`). Per-instance affinity confirmed. Each sessionId maps to a dedicated container instance. See https://alchemy.run/providers/cloudflare/container/#route-requests

**0d. PGLite in Miniflare/workerd verification**: Test whether `@electric-sql/pglite` (WASM-based embedded Postgres) works inside Miniflare's workerd runtime. PGLite needs filesystem access for on-disk storage — workerd has restricted node: compat. Write a 5-line test script. If PGLite doesn't work in workerd, the "empty DATABASE_URL → PGLite fallback" design (D5) needs revisiting — fallback to in-memory storage or a local Postgres process.

### Phase 1: Rewrite runtime-bridge to HTTP-first

Rewrite `packages/runtime-bridge/src/index.ts`. Remove the eager startup flow. Replace with an HTTP server that starts idle and handles one session at a time.

**Explicit: one bridge process = one session.** No session multiplexing.

**Endpoints** (per contract from Phase 0a):
- `POST /start` — receives `{ command, args, workspace, setup? }`. If `setup` is provided, runs it via `child_process.execSync(setup, { cwd: workspace })` before spawning the agent (SMI-1677). Then spawns agent, does ACP handshake, starts WS server + file watcher, responds with `{ sessionId, websocketUrl, port }`.
- `POST /terminate` — kills agent, stops file watcher, resets to idle
- `GET /health` — returns `{ status: "idle" | "running", sessionId? }`
- WebSocket at `/ws` — existing WS logic, unchanged

**Workspace setup (SMI-1677)**: The `setup` field is an optional shell command string (e.g. `"npm install && npm run build"`). The bridge runs it synchronously in the workspace directory before spawning the agent. This replaces the per-provider setup strategies from the original SMI-1677 design — one implementation in the bridge, works everywhere.

**On boot**: only the HTTP server starts on `BRIDGE_PORT` (default 8080). No agent, no ACP, no file watcher until `/start` is called.

**What stays the same**: ACP client implementation, WS protocol, file watcher, permission handling. Only the startup/lifecycle wrapper changes.

### Phase 2: Runtime-bridge Dockerfile

Create `packages/runtime-bridge/Dockerfile` (used by deployed mode only):

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY dist/ ./dist/
EXPOSE 8080
ENV BRIDGE_PORT=8080
CMD ["node", "dist/index.js"]
```

Note: `tsx` and `@agentclientprotocol/sdk` should be in `package.json` dependencies, not globally installed. Agents that need `tsx` at runtime will have it from the image's node_modules.

### Phase 3: Custom Alchemy resources

**`packages/flamecast/src/alchemy/database.ts`** — FlamecastDatabase resource (~60 lines):

- `this.scope.local === true`: Returns `{ connectionString: "" }` — empty string signals the storage layer to use PGLite on disk. Runs Drizzle migrations against PGLite.
- `this.scope.local === false`: PlanetScale Database + Branch + Password (per-stage isolation), runs Drizzle migrations, returns `{ connectionString: password.connectionString }`.
- `this.phase === "delete"`: local = no-op, deployed = destroy PlanetScale branch + credentials.
- Follows pattern from https://alchemy.run/guides/planetscale-drizzle/

**`packages/flamecast/src/alchemy/runtime.ts`** — FlamecastRuntime resource (factory pattern per D2):

- `this.scope.local === true`:
  - Starts a "bridge manager" HTTP server on a free port
  - Bridge manager handles `POST /sessions/:sessionId/start` by spawning a new bridge child process (child_process.spawn, per D4), passing BRIDGE_PORT=0 + agent config as env vars
  - Tracks `Map<sessionId, { pid, port }>` for cleanup
  - Returns `{ binding }` where binding is a Miniflare-compatible service pointing at the bridge manager
  - On delete: kills all tracked child processes, stops manager

- `this.scope.local === false`:
  - Creates CF Container resource with runtime-bridge Dockerfile
  - Returns `{ binding }` where binding is the Container DurableObjectNamespace
  - On delete: Alchemy destroys Container resource

**Risk note — bridge manager complexity**: The bridge manager (local mode) is the most novel component in the plan. It's an HTTP server with session-scoped routing, dynamic child process spawning with port discovery, process tracking, request forwarding, crash detection, and cleanup on alchemy dev restart. Estimate ~100-150 lines. Extract into its own file (`packages/flamecast/src/alchemy/bridge-manager.ts`) rather than inlining in the resource handler.

**`packages/flamecast/alchemy.run.ts`** — rewrite to ~20 lines (see target above). Remove `docker.Container("flamecast-db")`.

### Phase 4: SessionManager with DataPlaneBinding

Create `packages/flamecast/src/flamecast/session-manager.ts`. Uses the DataPlaneBinding interface (Phase 0b) — identical code for local and deployed. This is control plane code that provisions data plane instances:

```typescript
export function createSessionManager(binding: DataPlaneBinding): RuntimeProvider {
  return {
    async start({ spawn, sessionId, cwd, setup }) {
      const response = await binding.fetchSession(
        sessionId,
        new Request("http://bridge/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: spawn.command, args: spawn.args, workspace: cwd, setup }),
        }),
      );
      const { sessionId: bridgeSessionId, websocketUrl } = await response.json();
      return {
        websocketUrl,
        sessionId: bridgeSessionId,
        terminate: async () => {
          await binding.fetchSession(
            sessionId,
            new Request("http://bridge/terminate", { method: "POST" }),
          );
        },
      };
    },
  };
}
```

**Dependency**: Needs bridge HTTP contract (Phase 0a) and DataPlaneBinding interface (Phase 0b). Implementation can start after Phase 0 but will need Phase 1 and Phase 3 to test against.

### Phase 5: Wire worker.ts

Update `packages/flamecast/src/worker.ts`:
- Accept `Env` type with `DATABASE_URL` (string) and `RUNTIME` (service binding)
- Wrap `env.RUNTIME` in a DataPlaneBinding adapter (local: service binding `.fetch()` with sessionId in URL; deployed: DurableObjectNamespace wrapper)
- Create Flamecast with `createPsqlStorage({ url: env.DATABASE_URL || undefined })` — empty string → PGLite fallback
- Create session manager with `createSessionManager(dataPlaneBinding)`
- Cache Flamecast instance across requests

### Phase 6: WebSocket routing

Based on Phase 0c investigation:

**If containers directly addressable (expected)**: No work needed. `websocketUrl` from bridge points directly at the bridge. Browser connects there. Existing `getWebsocketUrl()` → `snapshotSession` plumbing handles it.

**If Worker proxy required**: Add WS upgrade forwarding in worker.ts — Worker receives upgrade, calls `binding.fetchSession(sessionId, upgradeRequest)`, pipes the WebSocket through. This is the fallback plan.

### Phase 7: Dev flow migration + validation

- Root `package.json`: replace `"dev": "turbo dev"` with `"dev": "alchemy dev"`
- Remove or simplify `turbo.json` `dev` task
- Verify `alchemy dev` starts: PGLite database, bridge manager + bridge child processes, Worker (Miniflare), Vite frontend
- Verify: zero Docker processes
- Run full verification (see below) before proceeding to cleanup

### Phase 8: Cleanup (after alchemy dev is validated)

- **`runtime-provider.ts`**: Remove `localProvisioner`, `dockerProvisioner`, `createDockerProvisioner`, `waitForBridgeReady`, `BRIDGE_ENTRY`, `noopTransport`, `waitForAcp`, `createRuntimeProvider`. Keep `RuntimeProvider` and `StartedRuntime` types. Keep `buildFileSystemSnapshot`, `createFileSystemEventStream` if used elsewhere.
- **`agent-templates.ts`**: Change `localRuntime()` → `{ provider: "container" }`. Remove docker-specific templates.
- **`runtime/remote.ts`**: Delete if exists.
- **`apps/server/`**: Remove or mark legacy. The Hono app factory (`createServerApp`) stays in `packages/flamecast` — it's imported by `worker.ts`. The standalone Node.js server in `apps/server/` is replaced by `alchemy dev`.
- **`docker/example-agent.Dockerfile`**, **`docker/codex-agent.Dockerfile`**: Remove.
- **`transport.ts`**: Remove `openLocalTransport`, `openTcpTransport`, `startAgentProcess`. Keep `AcpTransport` type if referenced.
- **Naming cleanup**: Rename `src/runtime/local.ts` → `src/flamecast/session-manager-local.ts`, `RuntimeClient` → `SessionManager`. Move remaining `src/runtime/` files into `src/flamecast/` or `src/session/`. Delete `src/runtime/` directory.

## Dependency Order

```
Phase 0 (interfaces + investigation) ──────────────────────────────────┐
    │                                                                   │
    ├──► Phase 1 (bridge rewrite) ──► Phase 2 (Dockerfile)             │
    │                                                                   │
    ├──► Phase 3 (custom resources + alchemy.run.ts) ◄─── Phase 2 ────┘
    │                                                  │
    └──► Phase 4 (container provider) ─────────────────┤
                                                       ▼
                                                 Phase 5 (worker.ts)
                                                       │
                                                 Phase 6 (WS routing)
                                                       │
                                                 Phase 7 (dev flow + validation)
                                                       │
                                                 Phase 8 (cleanup)
```

Phase 0 is pre-work for all subsequent phases. After Phase 0, Phases 1, 3, and 4 can proceed in parallel (they implement against the interfaces defined in Phase 0). Phase 5 converges them.

## Phase 0 Status: COMPLETE

**0a. Bridge HTTP contract**: Defined in `packages/runtime-bridge/src/protocol.ts` (source of truth) and mirrored in `packages/flamecast/src/flamecast/data-plane.ts` (consumer types).

**0b. DataPlaneBinding interface**: Defined in `packages/flamecast/src/flamecast/data-plane.ts` with both local and deployed implementation patterns documented.

**0c. CF Container networking**: RESOLVED — DO-style per-instance routing confirmed. `binding.idFromName(sessionId).get(id).fetch(request)` gives per-session affinity.

**0d. PGLite in workerd**: Worker is configured with `compatibility: "node"` in `alchemy.run.ts`. PGLite is WASM-based with Node.js `fs` fallback. Existing test suite runs PGLite successfully in Node.js. Should work in workerd with `nodejs_compat`. If not, fallback to in-memory PGLite (no disk path). Not a blocker — verify at integration time (Phase 7).

## Verification

1. `alchemy dev` starts all services successfully (zero Docker)
2. Open UI → create session with example agent → agent responds to prompts over WebSocket
3. `docker ps` shows NO Flamecast containers (bridge is bare Node process)
4. Create 2+ sessions → each gets its own bridge child process
5. Terminate session → bridge child process is cleaned up
6. `pnpm test` passes (tests mock the runtime provider)

## Resolved Issues

| # | Issue | Resolution |
|---|-------|------------|
| 1 | Exec won't work for daemons | Use child_process.spawn directly, store { pid, port } in resource state (D4) |
| 2 | Multi-session lifecycle undefined | Factory pattern — FlamecastRuntime returns a binding that spawns per-session bridges (D2) |
| 3 | runtime.binding undefined for local | Bridge manager HTTP server + Miniflare service binding (D6) |
| 4 | PGLite not wire-protocol compatible | PGLite runs inside Worker/Miniflare; empty DATABASE_URL triggers PGLite fallback in existing storage factory (D5) |
| 5 | Phase 4 parallel dependency incorrect | Added Phase 0 for interface definitions; Phase 4 implements against interfaces, tests against Phase 1+3 (Phase 0) |
| 6 | WS routing blocks Phase 4+5 design | Moved investigation to Phase 0c; default is direct connection (D7) |
| 7 | Single vs multi-session bridge | Explicit: one bridge per session, no multiplexing (D1) |

## Minor Issues Addressed

- **Dockerfile**: Removed `npm install -g tsx @agentclientprotocol/sdk`. These belong in `package.json` dependencies, installed via `npm install --production`.
- **apps/server/ removal**: Clarified that `createServerApp` (Hono app factory) stays in `packages/flamecast` — it's imported by `worker.ts`. Only the standalone Node server in `apps/server/` is deprecated.
- **PlanetScale Postgres GA**: Needs verification before Phase 3 deployed mode implementation. Can be deferred — local mode works without it.

## References

- Alchemy resource pattern: https://github.com/georgejeffers/alchemy-skills/blob/main/skills/alchemy/references/resource-patterns.md
- Alchemy concepts: https://github.com/georgejeffers/alchemy-skills/blob/main/skills/alchemy/references/alchemy-concepts.md
- PlanetScale + Drizzle guide: https://alchemy.run/guides/planetscale-drizzle/
- CF Container resource: https://alchemy.run/providers/cloudflare/container/
- Exec resource: https://alchemy.run/providers/os/exec/
