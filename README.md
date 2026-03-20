# acp / Flamecast

Local **Agent Client Protocol (ACP)** orchestrator: spawns agent processes, holds **ACP sessions** over NDJSON on stdio, exposes a **REST API**, and ships a small **React** UI to manage connections, send prompts, and resolve permission requests.

For **planned** evolution (sandboxing, durable projection, optional Convex), see [`SPEC.md`](SPEC.md).

---

## Stack

| Layer | Technology |
|--------|------------|
| Orchestration | `Flamecast` class — in-memory state, `@agentclientprotocol/sdk` |
| Agent I/O | `child_process.spawn`, stdin/stdout as Web Streams (`src/flamecast/transport.ts`) |
| API | [Hono](https://hono.dev/) on Node, `@hono/node-server`, port **3001**, mounted at `/api` |
| Validation | [Zod](https://zod.dev/) — shared request/response shapes in `src/shared/connection.ts` |
| Client | React 19, [Vite](https://vitejs.dev/) 8, [TanStack Router](https://tanstack.com/router) + [TanStack Query](https://tanstack.com/query), [Tailwind](https://tailwindcss.com/) v4 |
| Typesafe API client | `hono/client` — `src/client/lib/api.ts` |

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
    index.ts        # Flamecast — connections, ACP client, logs
    transport.ts    # spawn + stdio → streams; built-in agent presets
    agent.ts        # example agent process (tsx) for local dev
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

| Concern | Implementation |
|---------|----------------|
| Connection registry | `Map<string, ManagedConnection>` — numeric string IDs from a monotonic counter |
| Serializable snapshot | `ConnectionInfo`: label, spawn spec, `sessionId`, timestamps, `logs[]`, `pendingPermission` |
| ACP session | `ClientSideConnection` over `acp.ndJsonStream(stdin, stdout)` |
| OS process | `ChildProcess` from `startAgentProcess` — killed on `DELETE /connections/:id` |
| Permissions | `requestPermission` from agent → UI-facing `PendingPermission` + `Map<requestId, resolver>` until user responds |

**`ManagedConnection`** pairs:

- **`info`** — what the API serializes (copy of logs on read via `snapshotInfo`).
- **`runtime`** — `ClientSideConnection | null`, `ChildProcess` (not sent to clients).

**Client role (ACP “client” side):** Flamecast implements `acp.Client`: session updates and tool notifications become **log entries**; `readTextFile` / `writeTextFile` are stubbed (log + empty response); `requestPermission` blocks until HTTP resolves the pending request.

**Logging:** `pushLog(managed, type, data)` appends `{ timestamp, type, data }` to `info.logs`. **RPC tracing** uses `type: "rpc"` with `data.method` (spec method name), `data.direction` (`client_to_agent` or `agent_to_client`), `data.phase` (`request`, `response`, or `notification`), and `data.payload` (the RPC payload as received or sent). That covers every **client-handled** agent→client method in the SDK (`session/update`, `session/request_permission`, `fs/*`, `terminal/*`, client `ext*`) plus orchestrator→agent calls made today (`initialize`, `session/new`, `session/prompt`). UI flow events keep their own types: `permission_*` and `killed`.

---

## Agent processes and transport

- **`registerAgentProcess` / built-in presets** — Stored in `agentProcesses` `Map` (UUID for user-registered; built-ins use stable ids from `getBuiltinAgentProcessPresets()` in `transport.ts`, e.g. example `tsx` agent path, Codex ACP via `npx`).
- **`create`** — Requires exactly one of `agentProcessId` (preset) or inline `spawn` + optional `label`; optional `cwd` for `newSession` (defaults `process.cwd()`).
- **Streams** — `getAgentProcess` wires `WritableStream` → stdin, stdout → `ReadableStream<Uint8Array>` for the SDK.

---

## HTTP API

Base URL in dev: `http://localhost:3001/api` (browser uses `http://localhost:3000/api` via Vite proxy).

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/agent-processes` | — | List registerable agent definitions (built-ins + user-registered). |
| `POST` | `/agent-processes` | `RegisterAgentProcessBody` | Register `{ label, spawn }`; returns `AgentProcessInfo` with new `id`. |
| `GET` | `/connections` | — | List all connections (snapshots). |
| `POST` | `/connections` | `CreateConnectionBody` | Spawn agent, `initialize`, `newSession`; `201` + `ConnectionInfo`. |
| `GET` | `/connections/:id` | — | Snapshot for one connection; `404` if unknown. |
| `POST` | `/connections/:id/prompt` | `{ text }` | Run ACP `prompt`; returns prompt result (e.g. `stopReason`). |
| `POST` | `/connections/:id/permissions/:requestId` | `{ optionId }` or `{ outcome: "cancelled" }` | Resolve pending permission. |
| `DELETE` | `/connections/:id` | — | Kill process, remove connection. |

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

Other scripts: `npm run build`, `npm start` (production build entry — verify `dist` layout for your deploy target), `npm run lint`, `npm run format`, `npm run cli` (separate entrypoint in `src/index.ts`; may not match the latest `CreateConnectionBody` shape).

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
