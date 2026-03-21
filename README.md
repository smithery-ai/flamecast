# Flamecast

Open-source **ACP (Agent Client Protocol)** orchestrator. Spawns and manages AI coding agents — locally or in Docker containers — via a REST API. Ships a React UI and deploys anywhere via [Alchemy](https://alchemy.run).

---

## Quick start

```bash
npm install
npm run dev          # API (port 3001) + Vite UI (port 3000)
```

Open **http://localhost:3000**. Click **Connect** on an agent to start a session.

---

## Stack

| Layer | Technology |
|---|---|
| Orchestration | `Flamecast` class + pluggable provisioner + `FlamecastStateManager` |
| Agent transport | Local: `child_process` + stdio. Docker: TCP + ndjson |
| Infrastructure | [Alchemy](https://alchemy.run) — Docker containers, Cloudflare Workers, DB provisioning |
| API | [Hono](https://hono.dev/) on Node (`@hono/node-server`), port 3001 |
| Validation | [Zod](https://zod.dev/) — shared schemas in `src/shared/connection.ts` |
| Client | React 19, Vite 8, TanStack Router + Query, Tailwind v4 |
| Typesafe API | `hono/client` — `src/client/lib/api.ts` |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Server (src/server/index.ts)                        │
│   Node + Hono on port 3001                          │
│   PGLite or Postgres for state                      │
│   Alchemy initialized at startup for scope mgmt    │
└─────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────┐
│ Flamecast (src/flamecast/index.ts)                  │
│   Pure orchestration — zero infra dependencies      │
│   Calls provisioner(connectionId, spec, runtime)    │
│   Gets back AcpTransport streams, speaks ACP        │
└─────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────┐
│ Provisioner (src/flamecast/config.ts)               │
│   runtime.type === "local" → ChildProcess + stdio   │
│   runtime.type === "docker" → alchemy/docker        │
│     → docker.Image + docker.Container + TCP         │
│   runtime.type === "{any}" → alchemy/{type}         │
└─────────────────────────────────────────────────────┘
```

### How it works

1. **Flamecast is pure orchestration.** The `Flamecast` class has zero infrastructure dependencies — no alchemy, no Docker, no Node-specific APIs. It takes a `provisioner` function and calls it.

2. **The provisioner is a function:** `(connectionId, spec, runtime) => Promise<AcpTransport>`. It receives the agent's `runtime` config, creates the sandbox (process, container, etc.), and returns streams for ACP communication.

3. **Non-local runtimes use Alchemy providers.** The provisioner dynamically imports `alchemy/${runtime.type}` — e.g. `alchemy/docker` for Docker containers. Alchemy handles resource lifecycle (create, update, delete) and state tracking automatically.

4. **`alchemy.run.ts`** exists as an experimental control plane definition (DB + Worker + Vite via Alchemy resources) but is **unstable**. The working local dev path is `npm run dev` which uses `src/server/index.ts` directly.

5. **`src/worker.ts`** is a Cloudflare Worker entry point for future deployment. Not production-ready yet.

---

## Agent configuration

Each agent preset carries a `runtime` that tells Flamecast how to sandbox it:

```typescript
// src/flamecast/presets.ts
{
  id: "example",
  label: "Example agent",
  spawn: { command: "npx", args: ["tsx", "src/flamecast/agent.ts"] },
  runtime: { type: "local" },
}

{
  id: "example-docker",
  label: "Example agent (Docker)",
  spawn: { command: "npx", args: ["tsx", "agent.ts"] },
  runtime: {
    type: "docker",
    image: "flamecast/example-agent",
    dockerfile: "docker/example-agent.Dockerfile",
  },
}
```

### Runtime types

| Type | What happens | Alchemy provider |
|---|---|---|
| `local` | `child_process.spawn` + stdio streams | None — no sandbox |
| `docker` | Docker container + TCP transport | `alchemy/docker` |
| `cloudflare` | Cloudflare Container (Durable Object) | `alchemy/cloudflare` (planned) |
| `{any}` | Dynamically imports `alchemy/{type}` | Any alchemy provider |

### How the provisioner works

```
POST /connections { agentProcessId: "example-docker" }
  ↓
Flamecast looks up preset → runtime: { type: "docker", image: "...", dockerfile: "..." }
  ↓
Provisioner called: (connectionId, spec, runtime)
  ↓
import("alchemy/docker") → docker.Image() + docker.Container()
  ↓
waitForAcp(host, port) — verifies agent responds to ACP initialize
  ↓
openTcpTransport(host, port) → returns { input, output } streams
  ↓
Flamecast speaks ACP over the streams — same as local, just different transport
```

### Adding a new runtime

To support a new sandbox provider (e.g. Fly.io), add a preset:

```typescript
{
  id: "my-agent-fly",
  label: "My agent (Fly)",
  spawn: { command: "my-agent", args: [] },
  runtime: {
    type: "fly",           // → import("alchemy/fly")
    image: "my-agent:latest",
    // ...provider-specific config
  },
}
```

The provisioner will `import("alchemy/fly")` and call `provider.Container(...)`. Zero Flamecast code changes — just a new preset and an alchemy provider.

---

## Repository layout

```
alchemy.run.ts              # Control plane: Postgres + Worker + Vite
docker/
  example-agent.Dockerfile  # Example ACP agent container
  codex-agent.Dockerfile    # Codex ACP container
src/
  server/
    index.ts                # Node entry point
  worker.ts                 # Cloudflare Worker entry point
  flamecast/
    index.ts                # Flamecast class — pure orchestration
    api.ts                  # Hono API routes
    config.ts               # FlamecastOptions, createFlamecast(), default provisioner
    presets.ts               # Agent presets with runtime config
    transport.ts            # AcpTransport, openLocalTransport, openTcpTransport
    agent.ts                # Example ACP agent (stdio + TCP modes)
    state-manager.ts        # FlamecastStateManager interface
    db/client.ts            # PGLite / Postgres connection
    state-managers/
      memory/               # In-memory state manager
      psql/                 # Postgres state manager (PGLite or external)
  client/                   # React UI
  shared/
    connection.ts           # Zod schemas + types
test/
  flamecast.test.ts         # Orchestration tests (local + Docker)
  api.test.ts               # HTTP API contract tests
```

---

## Configuration

No `config.yaml` — configuration is TypeScript via `FlamecastOptions`:

```typescript
import { createFlamecast } from "./flamecast/config.js";

const flamecast = await createFlamecast({
  stateManager: { type: "pglite" },    // or "memory", "postgres"
  // provisioner is optional — defaults to local + Docker routing
});
```

### State manager options

| Type | Description |
|---|---|
| `pglite` (default) | Embedded Postgres on disk (`.acp/pglite`) |
| `memory` | In-process, lost on restart |
| `postgres` | External Postgres via `{ url }` |

### Environment variables

| Variable | Purpose |
|---|---|
| `FLAMECAST_POSTGRES_URL` | External Postgres connection string |
| `ACP_PGLITE_DIR` | Override PGLite data directory |

---

## HTTP API

Base URL: `http://localhost:3001/api`

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check — returns `{ status, connections }` |
| `GET` | `/agent-processes` | List agent presets |
| `POST` | `/agent-processes` | Register a custom agent |
| `GET` | `/connections` | List active connections |
| `POST` | `/connections` | Create connection (spawn agent) |
| `GET` | `/connections/:id` | Get connection details + logs |
| `POST` | `/connections/:id/prompt` | Send prompt to agent |
| `POST` | `/connections/:id/permissions/:requestId` | Resolve permission request |
| `DELETE` | `/connections/:id` | Kill connection |

---

## Deployment

### Local dev (Node)

```bash
npm run dev          # API + Vite UI
npm run dev:server   # API only
npm run dev:client   # Vite only
```

### Alchemy (Cloudflare + Docker) — unstable

> **Note:** Alchemy deployment and dev mode are still unstable. The Worker bundling, miniflare Container emulation, and Cloudflare Container provisioner are work-in-progress. Use `npm run dev` (Node) for reliable local development.

```bash
npm run alchemy:dev      # Local: miniflare + Docker Postgres + Vite
npm run alchemy:deploy   # Deploy to Cloudflare
npm run alchemy:destroy  # Tear down
```

`alchemy.run.ts` declares the control plane:
- **Postgres** in Docker (state manager)
- **Worker** on Cloudflare (API server)
- **Vite** (frontend)

---

## Testing

```bash
npm test    # Integration tests (vitest)
```

Tests use `alchemy.test()` for isolated scopes with automatic cleanup. Each test creates its own Flamecast instance.

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | API + Vite in parallel |
| `npm run dev:server` | API only (port 3001) |
| `npm run dev:client` | Vite only (port 3000) |
| `npm test` | Integration tests |
| `npm run lint` | ESLint |
| `npm run fmt` | ESLint fix + Prettier |
| `npm run alchemy:dev` | Local dev via alchemy |
| `npm run alchemy:deploy` | Deploy to Cloudflare |
| `npm run psql:generate` | Generate Drizzle migrations |

---

## Current limitations

- **No auth** — local dev assumption; do not expose raw to the internet.
- **Single host** — one Node process; no distributed Flamecast.
- **Polling** — UI uses 1s polling, not SSE/WebSocket.
- **Worker provisioning** — Worker can't spawn local processes; needs Cloudflare Containers (follow-up).
- **Serverless reconnection** — `SandboxHandle` not yet persisted for reconnect across restarts.

---

## Related docs

- **[`PRD.md`](PRD.md)** — product requirements
- **[`SPEC.md`](SPEC.md)** — architecture spec
- **ACP** — protocol via `@agentclientprotocol/sdk`
- **[Alchemy](https://alchemy.run)** — infrastructure-as-code for provisioning
