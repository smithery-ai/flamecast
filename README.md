# acp / Flamecast

Local **Agent Client Protocol (ACP)** orchestrator: spawns agent processes, holds **ACP sessions** over NDJSON on stdio, exposes a **REST API**, and ships a small **React** UI to manage connections, send prompts, and resolve permission requests.

For **planned** evolution (sandboxing, durable projection, optional Convex), see [`SPEC.md`](SPEC.md).

---

## Stack

| Layer               | Technology                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestration       | `Flamecast` + injected **`FlamecastProjection`** (Drizzle/PGlite via `MemoryFlamecastProjection` in tests if needed), `@agentclientprotocol/sdk`                                |
| Agent I/O           | `child_process.spawn`, stdin/stdout as Web Streams (`src/flamecast/transport.ts`)                                                                                               |
| API                 | [Hono](https://hono.dev/) on Node, `@hono/node-server`, port **3001**, mounted at `/api`                                                                                        |
| Validation          | [Zod](https://zod.dev/) — shared request/response shapes in `src/shared/connection.ts`                                                                                          |
| Client              | React 19, [Vite](https://vitejs.dev/) 8, [TanStack Router](https://tanstack.com/router) + [TanStack Query](https://tanstack.com/query), [Tailwind](https://tailwindcss.com/) v4 |
| Typesafe API client | `hono/client` — `src/client/lib/api.ts`                                                                                                                                         |

---

## Repository layout

```
src/
  client/           # Vite app (port 3000); proxies /api → 3001
    routes/         # TanStack file routes: /, /connections/$id
    components/ui/  # shadcn-style primitives
    lib/api.ts      # hc<AppType> client
  server/
    index.ts        # Hono root, route("/api", api)
    api.ts          # REST handlers → Flamecast
  flamecast/
    index.ts        # Flamecast — runtime handles + ACP client
    projection.ts   # durable port (metadata + logs)
    projections/
      memory/       # in-memory FlamecastProjection
      psql/         # Drizzle schema + SQL migrations + createPsqlProjection (Postgres or PGLite)
    transport.ts    # spawn + stdio → streams; built-in agent presets
    agent.ts        # example agent process (tsx) for local dev
  server/db/
    client.ts       # createDatabase(): Postgres URL or local PGLite + migrate
  shared/
    connection.ts   # Zod schemas + TS types for API + Flamecast
```

---

## Runtime architecture

```mermaid
flowchart LR
  subgraph browser["Browser :3000"]
    UI["React + TanStack Query"]
  end
  subgraph node["Node :3001"]
    API["Hono /api"]
    FC["Flamecast"]
    CP["ChildProcess + stdio"]
  end
  UI <-->|"HTTP /api/*"| API
  API --> FC
  FC <-->|"NDJSON ACP"| CP
```

- **Single process** owns all connections: one `Flamecast` instance in `api.ts`. No horizontal scaling or persistence across restarts.
- **Agent** is always a **local subprocess** today; Flamecast does not provision containers (see `SPEC.md` Phase 1).

---

## Flamecast (orchestrator)

`Flamecast` (`src/flamecast/index.ts`) is the **runtime authority** for:

| Concern          | Implementation                                                                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live runtimes    | `Map<id, ManagedConnection>` — **only** `ClientSideConnection`, `ChildProcess`, stream buffer (not logs)                                                                                                                                                                          |
| Connection IDs   | **UUID** strings (`projection.allocateConnectionId`)                                                                                                                                                                                                                              |
| Durable snapshot | **`FlamecastProjection`** — `connections` row + append-only `connection_logs`; `GET` merges DB + live runtime                                                                                                                                                                     |
| Serializable API | `ConnectionInfo`: label, spawn spec, `sessionId`, timestamps, `logs[]` from DB, `pendingPermission` from DB row                                                                                                                                                                   |
| ACP session      | `ClientSideConnection` over `acp.ndJsonStream(stdin, stdout)`                                                                                                                                                                                                                     |
| OS process       | `ChildProcess` from `startAgentProcess` — killed on `DELETE /connections/:id`                                                                                                                                                                                                     |
| Permissions      | Pending request + resolver `Map` in-process; **durable** `pending_permission` on the connection row until **`POST /api/connections/:id/permissions/:requestId`** |

**`ManagedConnection`** pairs:

- **`id` / `sessionId`** — copied for hot paths; session id is kept in sync with the DB after `session/new`.
- **`runtime`** — `ClientSideConnection | null`, `ChildProcess`, coalesce buffer (not sent to clients).

**Client role (ACP “client” side):** Flamecast implements `acp.Client`: session updates and tool notifications become **log rows** in the projection; `readTextFile` / `writeTextFile` are stubbed (log + empty response). **`requestPermission`** resolves the ACP JSON-RPC response when the **web UI** (or any client) calls **`POST /api/connections/:id/permissions/:requestId`**.

**Logging:** `pushLog` is async and appends to the projection (`connection_logs`). **RPC tracing** uses `type: "rpc"` with the same `data` shape as before (`method`, `direction`, `phase`, optional `payload`).

**Database:** `createDatabase()` (`src/server/db/client.ts`) uses **Postgres** when `DATABASE_URL` or `ACP_DATABASE_URL` is set, otherwise **PGLite** under `.acp/pglite` (`ACP_PGLITE_DIR`). Schema lives in `src/flamecast/projections/psql/schema.ts`; Drizzle Kit writes SQL to `src/flamecast/projections/psql/migrations/`. Run `bun run db:generate` after schema edits and commit migrations.

If you previously used the inlined DDL-only setup, remove `.acp/pglite` once so the migrator can create tables cleanly.

**Stream coalescing (logs only):** consecutive agent→client `session/update` notifications with `sessionUpdate` `agent_message_chunk`, `user_message_chunk`, or `agent_thought_chunk` and **text** `content` are merged into a **single** `rpc` row (same shape as one notification, with concatenated `content.text`) until the stream breaks: different `sessionId`, different chunk kind, different optional `messageId`, any non–text chunk, any other `session/update` variant (e.g. `tool_call`), when a `session/prompt` turn finishes (success or throw), or when the connection is killed. The live ACP stream is unchanged. A rare `rpc_coalesce_error` row records join failures and falls back to per-fragment `rpc` rows.

---

## Agent processes and transport

- **`registerAgentProcess` / built-in presets** — Stored in `agentProcesses` `Map` (UUID for user-registered; built-ins use stable ids from `getBuiltinAgentProcessPresets()` in `transport.ts`, e.g. example `tsx` agent path, Codex ACP via `npx`).
- **`create`** — Requires exactly one of `agentProcessId` (preset) or inline `spawn` + optional `label`; optional `cwd` for `newSession` (defaults `process.cwd()`).
- **Streams** — `getAgentProcess` wires `WritableStream` → stdin, stdout → `ReadableStream<Uint8Array>` for the SDK.

---

## HTTP API

Base URL in dev: `http://localhost:3001/api` (browser uses `http://localhost:3000/api` via Vite proxy).

| Method   | Path                                      | Body                                         | Description                                                            |
| -------- | ----------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `GET`    | `/agent-processes`                        | —                                            | List registerable agent definitions (built-ins + user-registered).     |
| `POST`   | `/agent-processes`                        | `RegisterAgentProcessBody`                   | Register `{ label, spawn }`; returns `AgentProcessInfo` with new `id`. |
| `GET`    | `/connections`                            | —                                            | List all connections (snapshots).                                      |
| `POST`   | `/connections`                            | `CreateConnectionBody`                       | Spawn agent, `initialize`, `newSession`; `201` + `ConnectionInfo`.     |
| `GET`    | `/connections/:id`                        | —                                            | Snapshot for one connection; `404` if unknown.                         |
| `POST`   | `/connections/:id/prompt`                 | `{ text }`                                   | Run ACP `prompt`; returns prompt result (e.g. `stopReason`).           |
| `POST`   | `/connections/:id/permissions/:requestId` | `{ optionId }` or `{ outcome: "cancelled" }` | Resolve pending permission.                                            |
| `DELETE` | `/connections/:id`                        | —                                            | Kill process, remove connection.                                       |

Schemas and TypeScript types: **`src/shared/connection.ts`**.

---

## Web client

- **Routes:** `/` — list connections, create flow; `/connections/$id` — detail, prompt input, permission card, log scroll area.
- **Data loading:** React Query `fetchConnection` / list endpoints; connection detail uses **`refetchInterval: 1000`** so logs and permission state update without push.
- **API helper:** `hc<AppType>("/api")` keeps client aligned with `src/server/api.ts` exports.

---

## Scripts

```bash
npm install
npm run dev          # API (tsx watch) + Vite in parallel
# or separately:
npm run dev:server   # API only :3001
npm run dev:client   # Vite only :3000
```

Open **http://localhost:3000**. Ensure agent binaries (e.g. `npx`, `tsx`) are available if you use presets that need them.

Other scripts: `npm run build`, `npm start` (production build entry — verify `dist` layout for your deploy target), `npm run lint`, `npm run format`.

---

## Current limitations (by design)

- **No durable store** — restart clears connections and logs.
- **No auth** — local dev assumption; do not expose raw to the internet.
- **Single host** — one Node process; no sticky sessions or distributed Flamecast.
- **Push updates** — UI relies on polling, not SSE/WebSocket (see `SPEC.md` if that changes).

---

## Related documentation

- **[`SPEC.md`](SPEC.md)** — phased roadmap (sandbox orchestration, projection port, optional Convex).
- **ACP** — protocol and behavior via `@agentclientprotocol/sdk`.
