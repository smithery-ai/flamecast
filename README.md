# Flamecast

Flamecast is an open-source, self-hostable control plane for ACP-compatible agents. It starts and manages agent sessions behind a REST API, brokers ACP permission requests, persists session metadata and logs, and ships a reference React UI on top of that API.

---

## Quick start

```bash
npm install
npm run dev
```

Open **http://localhost:3000**. The home page lists the registered agent templates; click **Start session** on one to launch a session.

---

## Stack

| Layer | Technology |
|---|---|
| Control plane | `Flamecast` class + Hono API + ACP client connection |
| Storage | `FlamecastStorage` with memory, PGLite, or Postgres backends |
| Runtime providers | Built-in `local` and `docker` providers, plus custom provider registry support |
| Infrastructure | [Alchemy](https://alchemy.run) for Docker provisioning and experimental deployment flows |
| API | [Hono](https://hono.dev/) on Node (`@hono/node-server`), port 3001 |
| Validation | [Zod](https://zod.dev/) schemas in `src/shared/session.ts` |
| Client | React 19, Vite 8, TanStack Router + Query, Tailwind v4 |
| Typesafe API | `hono/client` in `src/client/lib/api.ts` |

---

## Architecture

```text
┌─────────────────────────────────────────────────────┐
│ Server (src/server/index.ts)                        │
│   Creates new Flamecast()                           │
│   Exposes the Hono app on port 3001                 │
└─────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────┐
│ Flamecast (src/flamecast/index.ts)                  │
│   Owns session lifecycle, ACP client wiring,        │
│   storage initialization, and runtime provider      │
│   dispatch                                           │
└─────────────────────────────────────────────────────┘
          │
          ├──────────────────────────────┐
          ▼                              ▼
┌───────────────────────────────┐  ┌────────────────────┐
│ Storage                       │  │ Runtime providers  │
│   memory / pglite / postgres  │  │   local / docker   │
│   metadata + logs             │  │   custom providers │
└───────────────────────────────┘  └────────────────────┘
                                          │
                                          ▼
                               ┌────────────────────────┐
                               │ ACP-compatible agent   │
                               │ process or container   │
                               └────────────────────────┘
```

### How it works

1. `Flamecast` lazily resolves storage and its runtime provider registry when the first API call or `listen()` happens.
2. `POST /api/sessions` resolves either an `agentTemplateId` or an ad-hoc `spawn` definition.
3. The selected runtime provider starts the agent and returns an ACP transport plus a termination handle.
4. Flamecast performs ACP `initialize` and `session/new`, then persists the session under the ACP `sessionId`.
5. All subsequent prompts, permission responses, and log retrieval use that ACP `sessionId` as the session ID everywhere.

---

## Agent templates

Each agent template defines the reusable information needed to launch an agent:

- `id`
- `name`
- `spawn`
- `runtime`

Built-in templates live in `src/flamecast/agent-templates.ts`:

```ts
{
  id: "example",
  name: "Example agent",
  spawn: { command: "npx", args: ["tsx", "src/flamecast/agent.ts"] },
  runtime: { provider: "local" },
}

{
  id: "example-docker",
  name: "Example agent (Uses stock docker containers)",
  spawn: { command: "npx", args: ["tsx", "agent.ts"] },
  runtime: {
    provider: "docker",
    image: "flamecast/example-agent",
    dockerfile: "docker/example-agent.Dockerfile",
  },
}
```

`POST /api/agent-templates` registers additional templates in storage, so they survive Flamecast restarts as long as the configured storage backend is durable.

### Template-driven session creation

```text
POST /api/sessions { agentTemplateId: "example-docker" }
  ↓
Flamecast loads the template
  ↓
runtime.provider === "docker"
  ↓
The docker runtime provider starts the container and returns an ACP transport
  ↓
Flamecast initializes ACP, creates the session, and persists logs under the ACP sessionId
```

You can also create a one-off session without registering a template first:

```json
{
  "spawn": {
    "command": "npx",
    "args": ["tsx", "src/flamecast/agent.ts"]
  },
  "name": "Scratch agent"
}
```

---

## Runtime providers

Runtime providers are responsible for starting the actual agent runtime and returning a live ACP transport.

| Provider | What it does |
|---|---|
| `local` | Uses `child_process.spawn()` and stdio |
| `docker` | Uses `alchemy/docker`, waits for ACP readiness, then connects over TCP |

Custom providers can be added through the `runtimeProviders` option:

```ts
import { Flamecast } from "./src/flamecast/index.js";

const flamecast = new Flamecast({
  runtimeProviders: {
    remote: {
      async start() {
        const transport = await openRemoteTransportSomehow();
        return {
          transport,
          terminate: async () => {
            await transport.dispose?.();
          },
        };
      },
    },
  },
  agentTemplates: [
    {
      id: "remote-agent",
      name: "Remote agent",
      spawn: { command: "remote-agent", args: [] },
      runtime: { provider: "remote" },
    },
  ],
});
```

If you pass `agentTemplates`, they replace the bundled defaults.

---

## Repository layout

```text
alchemy.run.ts              # Experimental control plane: Postgres + Worker + Vite
docker/
  example-agent.Dockerfile  # Example ACP agent container
  codex-agent.Dockerfile    # Codex ACP container
src/
  server/
    app.ts                  # Root Hono app
    index.ts                # Node entry point
  worker.ts                 # Cloudflare Worker entry point
  flamecast/
    index.ts                # Flamecast class
    api.ts                  # REST API routes
    storage.ts              # FlamecastStorage + config resolution
    runtime-provider.ts     # Built-in runtime providers
    agent-templates.ts      # Built-in agent templates
    transport.ts            # AcpTransport, local/tcp helpers
    agent.ts                # Example ACP agent (stdio + TCP modes)
    db/client.ts            # PGLite / Postgres connection
    storage/
      memory/               # In-memory storage implementation
      psql/                 # Postgres/PGLite storage implementation
  client/                   # React UI
  shared/
    session.ts              # Zod schemas + shared API types
test/
  flamecast.test.ts         # Orchestration tests
  api.test.ts               # HTTP API contract tests
```

---

## Configuration

Configuration is TypeScript via the `Flamecast` constructor:

```ts
import { Flamecast } from "./src/flamecast/index.js";

const flamecast = new Flamecast({
  storage: "pglite",
});

await flamecast.listen(3001);
```

The same instance also exposes a standard `fetch` handler:

```ts
import { Flamecast } from "./src/flamecast/index.js";

const flamecast = new Flamecast({
  storage: { type: "postgres", url: process.env.DATABASE_URL! },
});

export default flamecast.fetch;
```

### Constructor options

| Option | Description |
|---|---|
| `storage` | Persistence backend. Defaults to `pglite` |
| `runtimeProviders` | Registry overrides or additional runtime providers |
| `agentTemplates` | Initial agent template list. Replaces bundled defaults when provided |

### Storage options

| Value | Description |
|---|---|
| `"pglite"` | Embedded Postgres on disk |
| `"memory"` | In-process, lost on restart |
| `{ type: "pglite", dataDir }` | Embedded Postgres with explicit data directory |
| `{ type: "postgres", url }` | External Postgres |
| custom `FlamecastStorage` | Bring your own storage implementation |

### Environment variables

| Variable | Purpose |
|---|---|
| `FLAMECAST_POSTGRES_URL` | External Postgres connection string |
| `ACP_PGLITE_DIR` | Override the default PGLite data directory |

---

## HTTP API

Base URL: `http://localhost:3001/api`

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check. Returns `{ status, sessions }` |
| `GET` | `/agent-templates` | List available agent templates |
| `POST` | `/agent-templates` | Register a custom agent template |
| `GET` | `/sessions` | List active sessions |
| `POST` | `/sessions` | Create a session |
| `GET` | `/sessions/:id` | Get session details + logs |
| `POST` | `/sessions/:id/prompt` | Send a prompt to the agent |
| `POST` | `/sessions/:id/permissions/:requestId` | Resolve a permission request |
| `DELETE` | `/sessions/:id` | Terminate a session |

---

## Deployment

### Local dev (Node)

```bash
npm run dev
npm run dev:server
npm run dev:client
```

### Alchemy / Worker path

`alchemy.run.ts` and `src/worker.ts` are still experimental. The Worker entry point can serve the API, but the built-in `local` and `docker` providers are intentionally stubbed there and will throw unless you configure a provider that works in that environment.

Use `npm run dev` for the stable local development flow.

---

## Testing

```bash
npm test
npm run check
```

Tests create isolated Flamecast instances and exercise the API surface end-to-end.

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | API + Vite in parallel |
| `npm run dev:server` | API only |
| `npm run dev:client` | Vite only |
| `npm test` | Integration tests |
| `npm run check` | Lint + format + build + API coverage |
| `npm run fmt` | ESLint fix + Prettier |
| `npm run alchemy:dev` | Local dev via Alchemy |
| `npm run alchemy:deploy` | Deploy via Alchemy |
| `npm run alchemy:destroy` | Tear down Alchemy resources |
| `npm run psql:generate` | Generate Drizzle migrations |

---

## Current limitations

- No auth or multi-tenancy.
- Single-process control plane; no distributed coordination.
- The UI polls rather than streaming over SSE or WebSockets.
- Worker deployment needs non-local runtime providers.
- Runtime reconnection across process restarts is not implemented yet.

---

## Related docs

- [ACP](https://agentclientprotocol.com/)
- [Alchemy](https://alchemy.run)
