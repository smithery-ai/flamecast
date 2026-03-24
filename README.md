# Flamecast

Flamecast is an open-source, self-hostable control plane for [ACP](https://agentclientprotocol.com/)-compatible agents. It manages agent sessions behind a REST API, brokers permission requests, persists session metadata, and ships a React UI — all with real-time WebSocket connectivity.

Infrastructure is managed with [Alchemy](https://alchemy.run), which handles local dev (PGLite, Miniflare, session router) and deployed mode (Neon Postgres, Cloudflare Workers, CF Containers) from a single `alchemy.run.ts` definition.

---

## Quick start

```bash
pnpm install
pnpm dev
```

Open **http://localhost:3000**. Click **Start session** on a template to launch an agent.

`pnpm dev` builds all packages, then starts the full stack via `alchemy dev`:
- PGLite database (zero-config local Postgres)
- Session router + runtime bridges
- Miniflare Worker (API on :3001)
- Vite dev server (UI on :3000)

---

## Deploy to Cloudflare

```bash
pnpm alchemy:deploy
```

This builds, then runs `alchemy deploy --stage prod` which provisions:
- **Neon Postgres** + Hyperdrive connection pooling
- **CF Container** running the runtime-bridge (one isolated instance per session)
- **CF Worker** serving the API
- **CF Pages** for the static UI

Secrets are injected via [Infisical](https://infisical.com). Required env vars: `ALCHEMY_PASSWORD`, `NEON_API_KEY`, Cloudflare credentials.

After deploying, seed the database:

```bash
DATABASE_URL="<neon-connection-string>" pnpm --filter @flamecast/storage-psql db:seed
```

---

## How it works

```
alchemy dev (local)                    alchemy deploy (Cloudflare)
├─ PGLite (:5432)                      ├─ Neon Postgres + Hyperdrive
├─ Session router (:random)            ├─ CF Container (per-session isolation)
│  └─ runtime-bridge per session       │  └─ runtime-bridge + agent
├─ Miniflare Worker (:3001)            ├─ CF Worker (same code)
└─ Vite (:3000)                        └─ CF Pages (same build)
```

1. `POST /api/agents` resolves an agent template and calls SessionManager
2. SessionManager provisions a runtime-bridge instance (local process or CF Container)
3. The bridge runs an optional `setup` command (install deps), then spawns the agent
4. Agent communicates via ACP over stdio; bridge exposes a WebSocket for the UI
5. In deployed mode, WebSocket is proxied through the Worker: `wss://<worker>/api/agents/:id/ws`

Agent templates define what to run and how to set up the environment:

```json
{
  "name": "Example agent",
  "spawn": { "command": "npx", "args": ["tsx", "packages/flamecast/src/flamecast/agent.ts"] },
  "runtime": {
    "provider": "container",
    "setup": "npm install tsx @agentclientprotocol/sdk && curl -o agent.ts ..."
  }
}
```

---

## Scripts

| Script | Description |
|---|---|
| `pnpm dev` | Full local stack (build + alchemy dev) |
| `pnpm build` | Build all packages |
| `pnpm test` | Run tests |
| `pnpm check` | Lint + format + build + test + knip |
| `pnpm alchemy:deploy` | Deploy to Cloudflare |
| `pnpm alchemy:destroy` | Tear down all resources |
| `pnpm fmt` | Auto-fix lint + format |

---

## Repository layout

```
alchemy.run.ts              # Infrastructure definition (database, runtime, worker, client)
apps/
  worker/src/
    index.ts                # CF Worker entry point (API + WebSocket proxy)
    container.ts            # FlamecastRuntime Container class (CF Containers)
  server/src/
    index.ts                # Node entry point (local dev fallback)
packages/
  flamecast/src/
    server/app.ts           # Hono API app
    flamecast/
      api.ts                # REST routes
      session-manager.ts    # Session lifecycle + data plane binding
      data-plane.ts         # DataPlaneBinding interface
      agent.ts              # Example ACP agent
    alchemy/
      database.ts           # FlamecastDatabase resource (PGLite local, Neon deployed)
      runtime.ts            # FlamecastRuntime resource (session-router local, CF Container deployed)
    client/                 # React UI (TanStack Router + Query, Tailwind)
    shared/session.ts       # Zod schemas + API types
  flamecast-psql/           # @flamecast/storage-psql (Drizzle + postgres.js)
  runtime-bridge/           # Agent sidecar (spawns agent, ACP over stdio, WebSocket)
```

---

## Related

- [Agent Client Protocol](https://agentclientprotocol.com/)
- [Alchemy](https://alchemy.run)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
