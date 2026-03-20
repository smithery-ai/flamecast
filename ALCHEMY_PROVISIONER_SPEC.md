# Alchemy-Powered Infrastructure — Transition Spec

This document describes how Flamecast uses Alchemy internally to provision its entire infrastructure stack — server runtime, database, and agent sandboxes — from a single declarative TypeScript config. Users never interact with Alchemy directly. They describe what they want; Flamecast makes it happen.

## Context

**Where we are (PR #11):**

- `AcpTransport` interface with `openLocalTransport()` / `openTcpTransport()`
- `alchemy.run.ts` deploys environment infra (network, image, container) as a separate step
- `config.yaml` maps agent presets to static `host:port` — duplicating values from `alchemy.run.ts`
- Transport selection is an inline `if/else` in `Flamecast.create()`
- One shared container per preset — no per-connection isolation
- Server and database wiring is manual in `src/server/index.ts`

**Where the new SPEC wants us:**

- `Provisioner` interface with `start()` / `reconnect()` / `destroy()`
- `SandboxHandle` persisted for reconnection (enabling serverless)
- Per-connection containers with full lifecycle management
- `config.yaml` deleted — `FlamecastOptions` in TypeScript
- Flamecast owns Hono (`.fetch` / `.listen()`)

**The insight:** Alchemy's Resource primitive already implements lifecycle management with automatic state tracking — not just for agent sandboxes, but for every piece of Flamecast's infrastructure. The server runtime, the database, and the sandboxes are all resources that need to be created, tracked, and torn down. Alchemy handles all three. Users just pass config.

## User-facing API

The entire stack is configured through `FlamecastOptions`. No Alchemy imports, no infrastructure files, no separate deploy steps.

### Zero-config local dev

```typescript
const flamecast = new Flamecast();
flamecast.listen(3001);
// Server: Node .listen()
// Database: PGLite (embedded, .acp/pglite)
// Agents: local ChildProcess via stdio
// No Alchemy activated — instant startup
```

### Worktrees (parallel agents, isolated filesystem)

```typescript
const flamecast = new Flamecast({
  provisioner: { type: "worktree" },
});
flamecast.listen(3001);
// Server: Node .listen()
// Database: PGLite (default)
// Agents: local ChildProcess, each in its own git worktree
// Conductor-like: parallel agents making changes without conflicts
```

### Docker sandboxes (process + filesystem isolation)

```typescript
const flamecast = new Flamecast({
  provisioner: { type: "docker", image: "flamecast/example-agent" },
});
flamecast.listen(3001);
// Server: Node .listen()
// Database: PGLite (default)
// Agents: per-connection Docker containers
```

### Docker + worktrees (full isolation with repo access)

```typescript
const flamecast = new Flamecast({
  provisioner: { type: "docker", image: "flamecast/example-agent", worktree: true },
});
flamecast.listen(3001);
// Server: Node .listen()
// Database: PGLite (default)
// Agents: per-connection Docker containers, each with a worktree mounted in
```

### Fully deployed on Cloudflare

```typescript
const flamecast = new Flamecast({
  server: { type: "cloudflare-worker" },
  stateManager: { type: "d1" },
  provisioner: { type: "cloudflare-container", image: "registry.example.com/agent:latest" },
});
export default flamecast.fetch;
// Server: Cloudflare Worker
// Database: Cloudflare D1
// Agents: Cloudflare Containers
```

### AWS stack

```typescript
const flamecast = new Flamecast({
  server: { type: "node" },
  stateManager: { type: "postgres", url: process.env.DATABASE_URL },
  provisioner: { type: "ecs", cluster: "agents", taskDefinition: "agent-task" },
});
flamecast.listen(3001);
// Server: Node on ECS/EC2
// Database: RDS Postgres
// Agents: ECS tasks per connection
```

### Mix and match

```typescript
const flamecast = new Flamecast({
  stateManager: { type: "planetscale", url: process.env.DATABASE_URL },
  provisioner: { type: "docker", image: "flamecast/agent" },
});
flamecast.listen(3001);
// Server: Node (local/VPS)
// Database: PlanetScale (managed)
// Agents: Docker containers (local)
```

### Blessed stacks (convenience presets)

```typescript
// These could be shorthand for common combinations
const flamecast = new Flamecast({ stack: "cloudflare" });
// Equivalent to: server: cloudflare-worker, stateManager: d1, provisioner: cloudflare-container

const flamecast = new Flamecast({ stack: "local" });
// Equivalent to: server: node, stateManager: pglite, provisioner: local (default)
```

---

## Three infrastructure concerns

Flamecast manages three orthogonal infrastructure concerns. Each maps to an Alchemy provider (or to a zero-dependency local default when Alchemy isn't needed).

### 1. Server runtime — where Flamecast's API runs

| Config value          | What happens                                 | Alchemy provider                |
| --------------------- | -------------------------------------------- | ------------------------------- |
| `"node"` (default)    | `.listen()` on Node via `@hono/node-server`  | None — no Alchemy needed        |
| `"cloudflare-worker"` | Deploy as Cloudflare Worker, export `.fetch` | `alchemy/cloudflare` → `Worker` |
| `"vercel"`            | Deploy as Vercel serverless function         | Future                          |

For `"node"`, no Alchemy is involved — Flamecast just calls `serve()` from `@hono/node-server`. For cloud runtimes, Alchemy provisions the server resource as part of Layer 1 (environment infra).

### 2. State manager — where session data lives

| Config value         | What happens                        | Alchemy provider                    |
| -------------------- | ----------------------------------- | ----------------------------------- |
| `"pglite"` (default) | Embedded PGLite under `.acp/pglite` | None — local file                   |
| `"memory"`           | In-process, lost on restart         | None                                |
| `"postgres"`         | External Postgres via URL           | None — user provides URL            |
| `"d1"`               | Cloudflare D1 database              | `alchemy/cloudflare` → `D1Database` |
| `"planetscale"`      | PlanetScale managed Postgres        | `alchemy/planetscale` → `Database`  |
| `"neon"`             | Neon serverless Postgres            | `alchemy/neon` → `Database`         |

For `"pglite"`, `"memory"`, and `"postgres"` (user-provided URL), no Alchemy is involved. For managed databases, Alchemy provisions the database as part of Layer 1.

The `FlamecastStateManager` interface stays the same — it's the internal abstraction over all of these. Alchemy creates the database; the state manager implementation talks to it.

### 3. Provisioner — where agents run

| Config value                  | What happens                                          | Alchemy provider                              |
| ----------------------------- | ----------------------------------------------------- | --------------------------------------------- |
| (omitted)                     | Local `ChildProcess` via stdio, shared cwd            | None                                          |
| `"worktree"`                  | Local `ChildProcess`, per-connection git worktree     | None — just `git worktree`                    |
| `"docker"`                    | Per-connection Docker container                       | `alchemy/docker` → `Container`                |
| `"docker"` + `worktree: true` | Per-connection Docker container with worktree mounted | `alchemy/docker` → `Container` + git worktree |
| `"cloudflare-container"`      | Per-connection Cloudflare Container                   | `alchemy/cloudflare` → `Container`            |
| `"ecs"`                       | Per-connection ECS task                               | `alchemy/aws` → `EcsTask`                     |
| `"fly"`                       | Per-connection Fly machine                            | Future                                        |

Local ChildProcess and worktree provisioners don't use Alchemy. Remote/container provisioners use Alchemy for per-connection lifecycle (Layer 2). Worktree can compose with any container provisioner via the `worktree: true` flag.

---

## Internal architecture

### When Alchemy activates

Alchemy is **only initialized when at least one concern requires it**. The zero-config local path (`npx flamecast`) never touches Alchemy — no state files, no init overhead, instant startup.

```typescript
// Internal — Flamecast constructor
const needsAlchemy =
  (opts.server?.type !== "node" &&
    opts.stateManager?.type !== "pglite" &&
    opts.stateManager?.type !== "memory" &&
    opts.stateManager?.type !== "postgres") ||
  opts.provisioner != null;

if (needsAlchemy) {
  this.alchemyApp = await alchemy("flamecast", { stage: opts.stage ?? process.env.USER });
}
```

### Layer 1 — Environment infra (deploy once per stage)

Created during Flamecast startup or lazy on first use. Long-lived resources that persist across connections.

**What goes here:**

- Server runtime (Cloudflare Worker, Vercel function)
- Database (D1, PlanetScale, Neon)
- Docker images (built from Dockerfile)
- Docker networks
- Container registries

```typescript
// Internal — called during .listen() or lazy init
async ensureInfra() {
  if (this.infraReady) return;

  await alchemy.run("infra", async () => {
    // Server
    if (this.serverConfig.type === "cloudflare-worker") {
      this.worker = await cloudflare.Worker("api", { ... });
    }

    // Database
    if (this.dbConfig.type === "d1") {
      this.database = await cloudflare.D1Database("state", { ... });
    } else if (this.dbConfig.type === "planetscale") {
      this.database = await planetscale.Database("state", { ... });
    }

    // Provisioner shared infra
    if (this.provisionerConfig?.type === "docker") {
      if (this.provisionerConfig.dockerfile) {
        this.agentImage = await docker.Image("agent-image", {
          build: { dockerfile: this.provisionerConfig.dockerfile },
          ...
        });
      }
      this.agentNetwork = await docker.Network("agent-network", { ... });
    }
  });

  this.infraReady = true;
}
```

Alchemy's state diffing means this is idempotent — restart Flamecast and unchanged resources are skipped, not recreated.

### Layer 2 — Connection sandboxes (per-connection)

Each connection gets its own Alchemy scope. The provisioner creates the appropriate resource within that scope.

```
POST /connections      → Alchemy scope created → provider resource enters create phase → agent starts
reconnect (serverless) → scope re-entered → Alchemy returns stored state → reconnect to agent
DELETE /connections/:id → destroy(scope) → provider resource enters delete phase → agent removed
```

One connection = one scope = one resource. 1:1 cardinality.

```typescript
// Internal — resolveProvisioner maps config to Alchemy resource calls

function resolveProvisioner(config: ProvisionerConfig) {
  switch (config.type) {
    case "worktree":
      return {
        type: "local" as const, // stdio transport, not TCP
        start: async (connectionId: string, spawn: AgentSpawn) => {
          const worktreePath = await createWorktree(connectionId, config.branch);
          return { cwd: worktreePath, spawn };
        },
        destroy: async (connectionId: string) => {
          await removeWorktree(connectionId);
        },
      };

    case "docker":
      return {
        type: "remote" as const, // TCP transport
        start: async (connectionId: string) => {
          const worktreePath = config.worktree ? await createWorktree(connectionId) : undefined;
          const port = await findFreePort();

          await docker.Container(`sandbox-${connectionId}`, {
            image: config.image,
            environment: { ACP_PORT: String(port) },
            ports: [{ external: port, internal: port }],
            volumes: worktreePath ? [{ hostPath: worktreePath, containerPath: "/workspace" }] : [],
            start: true,
          });

          await waitForPort("localhost", port, 30_000);
          return { host: "localhost", port };
        },
        destroy: async (connectionId: string) => {
          if (config.worktree) await removeWorktree(connectionId);
        },
      };

    case "cloudflare-container":
      return {
        type: "remote" as const,
        start: async (connectionId: string) => {
          const container = await cloudflare.Container(`sandbox-${connectionId}`, {
            image: config.image,
          });
          return { host: container.hostname, port: container.port };
        },
      };

    case "ecs":
      return {
        type: "remote" as const,
        start: async (connectionId: string) => {
          const task = await aws.EcsTask(`sandbox-${connectionId}`, {
            taskDefinition: config.taskDefinition,
            cluster: config.cluster,
          });
          return { host: task.privateIp, port: 9100 };
        },
      };
  }
}
```

### Worktree lifecycle

Git worktrees give each connection an isolated copy of the repository without a full clone. Internally:

```typescript
// Internal — worktree helpers

async function createWorktree(connectionId: string, branch?: string): Promise<string> {
  const worktreePath = path.join(process.cwd(), ".flamecast-worktrees", connectionId);
  const branchName = branch ?? `flamecast/${connectionId}`;
  await exec(`git worktree add ${worktreePath} -b ${branchName}`);
  return worktreePath;
}

async function removeWorktree(connectionId: string): Promise<void> {
  const worktreePath = path.join(process.cwd(), ".flamecast-worktrees", connectionId);
  await exec(`git worktree remove ${worktreePath} --force`);
}
```

**Worktree-only** (`type: "worktree"`): agent runs as a local ChildProcess with `cwd` set to the worktree path. Uses stdio transport (same as default). The isolation is filesystem-level — each agent works on its own branch and can't conflict with others.

**Worktree + Docker** (`type: "docker", worktree: true`): the worktree is created on the host and **mounted into the container** at `/workspace`. The agent runs in Docker (process isolation) but reads/writes to the worktree (filesystem isolation). On `destroy`, both the container and the worktree are cleaned up.

This is the Conductor/Superset pattern from the PRD's competitive landscape — but exposed as API-driven orchestration, not a desktop GUI.

### Connection lifecycle

#### Creation

```typescript
// Inside Flamecast.create()

await this.ensureInfra(); // Layer 1 — idempotent

if (!this.provisioner) {
  // Default: local ChildProcess, shared cwd
  transport = openLocalTransport(spawn);
} else if (this.provisioner.type === "local") {
  // Worktree: local ChildProcess, isolated cwd
  const { cwd, spawn } = await this.provisioner.start(id, agentSpawn);
  transport = openLocalTransport(spawn, { cwd });
} else {
  // Remote: Alchemy-managed container (Docker, Cloudflare, ECS, etc.)
  const scope = await alchemy.run(`connection-${id}`, async () => {
    return await this.provisioner.start(id);
  });
  transport = await openTcpTransport(scope.host, scope.port);
}
```

#### Reconnection (serverless / restart recovery)

```typescript
// Re-enter the same scope — Alchemy sees existing state, skips create
const scope = await alchemy.run(`connection-${id}`, async () => {
  return await this.provisionFn(id);
});
const transport = await openTcpTransport(scope.host, scope.port);
```

#### Destruction

```typescript
// Inside Flamecast.kill()
if (managed.scope) {
  await destroy(managed.scope);
} else {
  managed.runtime.dispose();
}
```

### Shutdown

```typescript
// Flamecast.shutdown() — clean teardown
async shutdown() {
  // Kill all active connections
  for (const [id] of this.runtimes) {
    await this.kill(id);
  }
  // Finalize Alchemy app (cleanup orphaned Layer 1 resources if needed)
  if (this.alchemyApp) {
    await this.alchemyApp.finalize();
  }
}
```

## FlamecastOptions

```typescript
type ServerConfig =
  | { type: "node" } // default
  | { type: "cloudflare-worker" };

type StateManagerConfig =
  | { type: "pglite" } // default
  | { type: "memory" }
  | { type: "postgres"; url: string }
  | { type: "d1" }
  | { type: "planetscale"; url: string }
  | { type: "neon"; url: string };

type ProvisionerConfig =
  | { type: "worktree"; branch?: string }
  | {
      type: "docker";
      image: string;
      dockerfile?: string;
      worktree?: boolean;
      limits?: { memory?: string; cpus?: number };
    }
  | { type: "cloudflare-container"; image: string; worktree?: boolean }
  | { type: "ecs"; cluster: string; taskDefinition: string; worktree?: boolean }
  | {
      type: "custom";
      start: (connectionId: string) => Promise<{ host: string; port: number }>;
      destroy: (connectionId: string) => Promise<void>;
    };

type FlamecastOptions = {
  server?: ServerConfig; // default: { type: "node" }
  stateManager?: StateManagerConfig; // default: { type: "pglite" }
  provisioner?: ProvisionerConfig; // default: local ChildProcess (no Alchemy)
  stage?: string; // default: $USER — Alchemy stage for resource isolation
};
```

## What replaces what

| Current                                       | New                                           | Why                                                 |
| --------------------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| `src/server/index.ts` manual wiring           | `new Flamecast({ ... }).listen()`             | One constructor, Flamecast owns the stack           |
| `config.yaml`                                 | `FlamecastOptions` in TypeScript              | Type-safe, no file to keep in sync                  |
| `src/server/config.ts` + `loadServerConfig()` | Options parsed in constructor                 | No YAML parsing, no file I/O                        |
| `src/server/db/client.ts` manual DB setup     | Internal, driven by `stateManager` config     | Alchemy provisions managed DBs; local DBs just work |
| `alchemy.run.ts` as user-facing file          | Internal `ensureInfra()`                      | User doesn't manage infra files                     |
| `AgentRuntimeConfig` / agents map             | `ProvisionerConfig`                           | Provider-specific config without leaking internals  |
| Inline `if/else` transport selection          | Internal `resolveProvisioner()`               | Clean mapping from config to Alchemy resources      |
| Shared static container per preset            | Per-connection scope + resource               | Actual sandbox isolation                            |
| No reconnection                               | Re-enter scope → Alchemy returns stored state | Serverless becomes possible                         |

## What stays the same

- **`AcpTransport` interface** — still `{ input, output }`.
- **`FlamecastStateManager` interface** — still the internal abstraction over all database backends. Alchemy creates managed DBs; the state manager implementation talks to them.
- **`openLocalTransport()` / `openTcpTransport()`** — still the raw transport openers, used internally.
- **Agent code (`agent.ts`)** — unchanged. Still checks `ACP_PORT` env var for TCP mode.
- **Dockerfile** — unchanged.

## State management

Two distinct state systems coexist internally:

| Concern                                                         | System                | Purpose                                                            |
| --------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------ |
| Infrastructure state (container IDs, DB endpoints, server URLs) | Alchemy state store   | Track what's deployed, enable idempotent restarts and reconnection |
| Application state (ACP sessions, logs, permissions)             | FlamecastStateManager | Session journal — what happened in each connection                 |

Alchemy's state store is configured automatically based on the deployment target:

- Local dev → filesystem (`.alchemy/`)
- Cloudflare → `CloudflareStateStore` (Durable Objects)
- AWS → `S3StateStore`

The user never configures this — Flamecast picks the right state store to match the stack.

## Stage isolation

Stages are derived automatically or set explicitly:

```typescript
// Explicit
new Flamecast({ stage: "prod" });

// Auto-derived (internal defaults)
// - Local dev: $USER
// - CI: pr-${PR_NUMBER} or branch name
// - Production: "prod"
```

All Alchemy resources — server, database, sandboxes — are namespaced by stage. A developer's local containers can't collide with production. `alchemy destroy --stage pr-42` tears down everything for a PR.

## Adding new providers

Adding support for a new cloud provider (e.g., Fly.io) requires:

1. Add a variant to the relevant config union (`ProvisionerConfig`, `StateManagerConfig`, or `ServerConfig`)
2. Add a case to the internal resolver that calls the Alchemy provider
3. Ship

Users upgrade Flamecast, change one string in their config. No Alchemy knowledge needed.

## Migration steps

### Step 1: Define the config types

Add `ServerConfig`, `StateManagerConfig`, `ProvisionerConfig` union types. Update `FlamecastOptions` to accept them. Defaults match current behavior (node + pglite + local).

### Step 2: Implement resolveProvisioner()

Internal function mapping `ProvisionerConfig` → Alchemy resource factory. Start with `docker` only.

### Step 3: Implement resolveStateManager()

Internal function mapping `StateManagerConfig` → `FlamecastStateManager` implementation. This mostly exists already (`MemoryFlamecastStateManager`, `createPsqlStateManager`). Add cases for managed DBs that provision via Alchemy first, then connect.

### Step 4: Wire scope lifecycle into Flamecast.create() / kill()

- `create()`: if provisioner is configured, create an Alchemy scope, provision, open TCP transport.
- `kill()`: if the connection has a scope, `destroy(scope)`.

### Step 5: Implement ensureInfra()

Lazy Layer 1 initialization — build images, create networks, provision managed databases. Idempotent via Alchemy state diffing.

### Step 6: Flamecast owns Hono

Move Hono app creation into Flamecast. Expose `.fetch` and `.listen()`. Delete `src/server/index.ts`, `src/server/config.ts`, `src/server/db/client.ts`. The constructor replaces all of this wiring.

### Step 7: Delete external config

Remove `config.yaml`, `alchemy.run.ts` (user-facing), `AgentRuntimeSchema`, `AgentRuntimeConfig`, `loadServerConfig()`.

### Step 8: Update tests

Tests construct `new Flamecast({ provisioner: { type: "docker", ... } })` directly. Cleanup via `flamecast.shutdown()`. No external alchemy commands or config files.

## Design decisions

### Layer 1 lifecycle in serverless

Layer 1 (Worker + D1 + image registry) is provisioned at **deploy time**, not request time. CI/CD runs `alchemy deploy --stage prod` once. The deployed Worker's `.fetch` handler only does Layer 2 work (per-connection sandbox lifecycle). `ensureInfra()` in serverless mode is a read — Alchemy's `"read"` phase reconstructs state from the store without modifications, giving the handler access to Layer 1 outputs (image refs, DB bindings) without re-provisioning.

### Custom provisioners

Supported via escape hatch for providers Flamecast doesn't ship with:

```typescript
provisioner: {
  type: "custom",
  start: async (connectionId) => ({ host: "agent.internal", port: 9100 }),
  destroy: async (connectionId) => { /* cleanup */ },
}
```

This covers the "Remote" provisioner from the PRD — agents running on user-managed infra. Doesn't use Alchemy; the user manages lifecycle themselves. A few lines of code internally and prevents Flamecast from being a blocker for unusual setups.

### No blessed stack presets

Three fields (`server`, `stateManager`, `provisioner`) is already simple enough. A `{ stack: "cloudflare" }` shorthand saves one line but hides what's configured, creates "which overrides which?" ambiguity, and adds a concept users need to learn. Can be added later if a clear need emerges. For now, users copy from docs/examples.

### Image building

Lazy, within `ensureInfra()`. When `dockerfile` is provided in provisioner config, Flamecast builds the image as part of Layer 1 initialization. `ensureInfra()` is called from `create()` before the first provision. Alchemy's state diffing makes this idempotent — on restart with an unchanged Dockerfile, the build is skipped (existing state matches props). No explicit build command needed.

### Alchemy as a regular dependency

Alchemy is a regular dependency of Flamecast, not a peer dep. It's pure ESM TypeScript with zero native dependencies — the bundle cost is negligible. Making it optional would add conditional import complexity and produce confusing errors when someone sets `provisioner: "docker"` without installing Alchemy. The local code path (`npx flamecast` with no provisioner config) never calls into Alchemy, so there's no runtime cost when it's unused — just disk space.

### Reconnection semantics

When Flamecast reconnects to an existing sandbox (serverless cold start or orchestrator restart), it re-enters the Alchemy scope to recover the `{ host, port }` of the running agent container. The ACP session is a separate concern handled by `FlamecastStateManager`:

- **If the agent supports session resume**: Flamecast loads session state from the state manager and issues an ACP session resume handshake over the new transport.
- **If not (v1)**: the agent container is still running but the ACP session is lost. Flamecast can start a new session on the existing container, preserving the sandbox but not conversation history. This is acceptable for v1 — the container (expensive to create) survives, even if the session (cheap to recreate) doesn't.
