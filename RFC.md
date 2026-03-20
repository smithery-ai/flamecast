# RFC: Flamecast wraps Hono

## Status

Proposed

## Problem

Today the server entry point (`src/server/index.ts`) manually wires together config loading, DB creation, Flamecast instantiation, and Hono serving. Configuration lives in a `config.yaml` file parsed at startup. This has two problems:

1. **No serverless path.** There's no `fetch` export, and the boot path assumes a long-running process. Deploying to Vercel, Cloudflare, or any serverless platform is impossible.
2. **Agent lifetime is coupled to the orchestrator process.** `ManagedConnection` holds a `ChildProcess` and in-memory ACP streams. If the orchestrator dies, every agent session dies with it. And in serverless, the "orchestrator" only lives for one request.

## Goals

- Flamecast owns the HTTP layer. Consumers create a `Flamecast` instance and either call `.listen(port)` (CLI / local dev) or export `.fetch` (Vercel / serverless).
- `npx flamecast` keeps working from any directory — zero config.
- Custom config via `index.ts` + `npm run build && npm link` — same CLI, your provisioner/state manager.
- No more `config.yaml`. Constructor options replace it.
- Agent lifecycle is managed by a pluggable **provisioner**, decoupling agent lifetime from the orchestrator process.
- Chat platform integration via **Vercel Chat SDK** as a first-class constructor option.

## Design

### New `Flamecast` API

```ts
export type FlamecastOptions = {
  stateManager: "psql" | "memory";
  provisioner?: Provisioner; // defaults to LocalProvisioner
  chat?: {
    adapters: ChatAdapter[]; // Vercel Chat SDK adapters
  };
};

export class Flamecast {
  fetch: (req: Request) => Promise<Response>;

  constructor(opts: FlamecastOptions);

  /** Local dev / CLI convenience. Calls @hono/node-server serve(). */
  listen(port: number): void;
}
```

The constructor:

1. Stores the `stateManager` kind, provisioner, and chat adapters.
2. Loads built-in agent presets (same as today).
3. Builds the Hono app and API routes eagerly — routes are cheap, they just reference `this`.
4. Binds `this.fetch` to the Hono app's fetch handler.
5. If `chat.adapters` are provided, wires them up so messages from any platform become prompts and permission responses flow back as interactive messages.

DB initialization is **lazy** (runs once on first request via a private `ensureReady()`). This is critical for serverless cold starts where you can't do async work at module scope.

### Entry points

**Default CLI (`src/index.ts`)** — what `npx flamecast` runs:

```ts
import { Flamecast } from "./flamecast/index.js";

const flamecast = new Flamecast({ stateManager: "psql" });
flamecast.listen(3001);
```

**Custom config** — user writes their own `index.ts`, builds, and links:

```ts
import { Flamecast } from "flamecast";
import { SlackAdapter } from "@vercel/chat-sdk/adapters/slack";

const flamecast = new Flamecast({
  stateManager: "psql",
  provisioner: "docker",
  chat: {
    adapters: [new SlackAdapter({ token: process.env.SLACK_TOKEN })],
  },
});

flamecast.listen(3001);
```

```bash
npm run build && npm link

# Now use from any directory — same CLI, custom config
cd ~/projects/my-app
flamecast
```

**Serverless** — export `.fetch`:

```ts
export default flamecast.fetch;
```

### Provisioner interface

The provisioner replaces the current hard-coded `startAgentProcess()` / `getAgentTransport()` in `transport.ts`. It answers two questions: **how to start an agent** and **how to reconnect to one that's already running**.

```ts
/**
 * A handle to a running agent. Holds enough info to reconnect
 * (e.g. container ID, pod name, Fly machine ID).
 * Must be JSON-serializable — it gets persisted in the state manager
 * so the orchestrator can reconnect after restart or across requests.
 */
export type SandboxHandle = Record<string, unknown>;

/**
 * The streams Flamecast uses to speak ACP to the agent.
 */
export type AcpTransport = {
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
};

export interface Provisioner {
  /** Spin up a new agent and return a handle + open transport. */
  start(spec: AgentSpawn): Promise<{ handle: SandboxHandle; transport: AcpTransport }>;

  /** Reconnect to a previously provisioned agent using its persisted handle. */
  reconnect(handle: SandboxHandle): Promise<AcpTransport>;

  /** Tear down the agent (kill process, destroy container, etc.). */
  destroy(handle: SandboxHandle): Promise<void>;
}
```

**Built-in implementations:**

| Provisioner         | Agent lifetime                           | Where it runs | Serverless-compatible?       |
| ------------------- | ---------------------------------------- | ------------- | ---------------------------- |
| `LocalProvisioner`  | Tied to orchestrator process             | Same machine  | No                           |
| `DockerProvisioner` | Container, survives orchestrator restart | Docker daemon | Yes (if Docker is reachable) |
| `K8sProvisioner`    | K8s job/pod                              | Cluster       | Yes                          |
| `FlyProvisioner`    | Fly Machine                              | Fly.io        | Yes                          |
| `RemoteProvisioner` | Pre-existing agent, connect via TCP      | Anywhere      | Yes                          |

`LocalProvisioner` is what exists today — it wraps `child_process.spawn()` and returns stdio streams. It's the default when no provisioner is specified.

### How serverless works end-to-end

The critical insight: with a remote provisioner, the orchestrator doesn't need to hold the agent process. The flow becomes:

1. **`POST /connections`** — Provisioner starts a container/machine. The `SandboxHandle` (e.g. `{ flyMachineId: "..." }`) is persisted to Postgres alongside the connection metadata.
2. **`POST /connections/:id/prompt`** — Orchestrator calls `provisioner.reconnect(handle)` to get ACP streams to the still-running agent, sends the prompt, waits for the response, and returns it. The streams are opened and closed within the request lifecycle.
3. **`DELETE /connections/:id`** — Orchestrator calls `provisioner.destroy(handle)` and finalizes the connection in Postgres.

This means **every request is self-contained**: open transport, do ACP work, close transport. No long-lived in-memory state needed. Serverless works.

**Caveat — permission requests:** Today, when an agent requests permission, Flamecast holds a Promise resolver in memory until the user responds. In serverless, this can't span requests. Two options:

- **Option A (recommended for v1):** The agent blocks on the permission request. The prompt request to Flamecast times out. The client polls, sees the pending permission, approves/denies it, and re-prompts. The agent retries the tool call.
- **Option B (future):** The provisioner exposes a persistent message channel (e.g. Redis pub/sub, Fly machine exec) so the permission response can be pushed to the agent without holding a connection open.

### Chat SDK integration

When `chat.adapters` are provided, Flamecast:

1. Initializes Chat SDK with the given adapters during `listen()` or on first `fetch`.
2. Registers a handler for new mentions / messages on each platform.
3. On incoming message: resolves the connection (or creates one), calls `this.prompt()`, and posts the response back to the thread.
4. On pending permission: posts an interactive message with approve/deny buttons. When the user clicks, calls `this.respondToPermission()`.

The chat integration uses the same Flamecast methods as the HTTP API — it's just another client. State, logs, and permissions are shared across all surfaces (web UI, chat, API calls).

### Lazy state manager init

```ts
private stateManagerInstance: FlamecastStateManager | null = null;
private stateManagerReady: Promise<FlamecastStateManager> | null = null;

private ensureReady(): Promise<FlamecastStateManager> {
  if (this.stateManagerInstance) return Promise.resolve(this.stateManagerInstance);
  if (!this.stateManagerReady) {
    this.stateManagerReady = (async () => {
      if (this.stateManagerKind === "memory") {
        this.stateManagerInstance = new MemoryFlamecastStateManager();
      } else {
        const { db } = await createDatabase();
        this.stateManagerInstance = createPsqlStateManager(db);
      }
      return this.stateManagerInstance;
    })();
  }
  return this.stateManagerReady;
}
```

Concurrent requests during cold start share the same init promise — DB is created exactly once.

### `ManagedConnection` changes

Today:

```ts
interface ManagedConnection {
  id: string;
  sessionId: string;
  runtime: {
    connection: acp.ClientSideConnection | null;
    agentProcess: ChildProcess; // <-- in-memory, dies with process
    sessionTextChunkLogBuffer: SessionTextChunkLogBuffer | null;
  };
}
```

After:

```ts
interface ManagedConnection {
  id: string;
  sessionId: string;
  sandboxHandle: SandboxHandle; // <-- persisted, survives restart
  runtime: {
    connection: acp.ClientSideConnection | null;
    transport: AcpTransport | null; // <-- opened per-request in serverless
    sessionTextChunkLogBuffer: SessionTextChunkLogBuffer | null;
  };
}
```

The `sandboxHandle` is stored in the state manager (new column on the `connections` table). For `LocalProvisioner`, the handle is `{ pid: number }` and reconnection isn't possible (process is gone if orchestrator restarts) — that's fine, it's the local-only mode.

### Async route handlers

Every Flamecast method starts with `const sm = await this.ensureReady()` and uses `sm` instead of `this.stateManager`. Self-contained — Flamecast is always safe to call regardless of how it's invoked, no middleware coordination.

## File changes

| Action     | Path                             | Notes                                                                                                                                                              |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Modify** | `src/flamecast/index.ts`         | Add `fetch`, `listen()`, lazy init, provisioner + chat SDK integration. `FlamecastOptions` takes string `stateManager` + optional `Provisioner` + optional `chat`. |
| **Modify** | `src/flamecast/transport.ts`     | Define `Provisioner`, `SandboxHandle`, `AcpTransport` interfaces. `LocalProvisioner` wraps existing `startAgentProcess` + `getAgentTransport`.                     |
| **Modify** | `src/flamecast/state-manager.ts` | Add `sandboxHandle` to `ConnectionMeta`.                                                                                                                           |
| **Modify** | `src/shared/connection.ts`       | Add `sandboxHandle` field to `ConnectionInfoSchema`.                                                                                                               |
| **Modify** | `src/server/api.ts`              | No route changes. `createApi` keeps taking a `Flamecast` instance.                                                                                                 |
| **Create** | `src/index.ts`                   | New CLI entry point (3 lines).                                                                                                                                     |
| **Modify** | `package.json`                   | Scripts point to `src/index.ts`. Add `"bin": { "flamecast": "./src/index.ts" }`.                                                                                   |
| **Delete** | `config.yaml`                    | Replaced by constructor options.                                                                                                                                   |
| **Delete** | `src/server/config.ts`           | No longer needed.                                                                                                                                                  |
| **Delete** | `src/server/index.ts`            | Replaced by `src/index.ts`.                                                                                                                                        |

### What stays the same

- `src/server/api.ts` — Hono route definitions (just imported by Flamecast now)
- `src/server/db/client.ts` — DB creation logic (called by Flamecast's lazy init)
- `src/flamecast/state-managers/*` — both implementations unchanged (schema migration for `sandboxHandle` column)
- `src/client/*` — frontend unchanged, still hits `/api` via proxy or direct
- `vite.config.ts` — unchanged (proxy to localhost:3001 in dev)

## Deployment matrix

| Target                      | Provisioner                           | State manager        | Notes                                   |
| --------------------------- | ------------------------------------- | -------------------- | --------------------------------------- |
| `npx flamecast`             | `LocalProvisioner` (default)          | PGLite on disk       | Zero-config, same as today              |
| Custom CLI (`build + link`) | Any                                   | Any                  | User's `index.ts` with their config     |
| Docker Compose              | `LocalProvisioner`                    | Postgres             | Agent processes inside the container    |
| K8s                         | `K8sProvisioner`                      | Postgres             | Agents as jobs, Flamecast as deployment |
| Vercel                      | `FlyProvisioner` / `ModalProvisioner` | Postgres (e.g. Neon) | Agents on Fly/Modal, API on Vercel      |
| Cloudflare Workers          | `RemoteProvisioner`                   | Postgres (e.g. Neon) | Agents hosted elsewhere, API on edge    |
| VPS                         | `DockerProvisioner`                   | Postgres             | Agents in containers on same box        |

## Migration for existing users

Before:

```
$ npx flamecast        # reads config.yaml from cwd
```

After:

```
$ npx flamecast        # same behavior, no config.yaml needed
```

The default (`stateManager: "psql"`, `provisioner: LocalProvisioner`) matches the old behavior exactly. `config.yaml` was already optional (missing file defaulted to psql). No user action required.

## Open questions

1. **Permission flow in serverless** — Option A (timeout + re-prompt) is simpler but worse UX. Option B (persistent channel) is better but adds infra. Which to build first?
2. **Streaming in serverless** — Today, `POST /connections/:id/prompt` blocks until the agent responds (including all text chunks). In serverless, this may hit request timeouts for long-running prompts. SSE or chunked responses could help, but adds complexity. Worth solving now or later?
3. **Transport reconnection semantics** — Should `reconnect()` re-initialize the ACP session or resume it? ACP may need a session-resume handshake to avoid re-running the init/newSession flow on every request.
4. **Chat SDK connection management** — When a message comes in from Slack/Discord, should it map to a long-lived connection (one per channel/thread) or create ephemeral connections? How does the user configure this mapping?
