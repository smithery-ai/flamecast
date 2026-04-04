# Flamecast – Bug & Functionality Report

> Generated after: installing dependencies, building the project, running the full test suite, and auditing the API, source code, and documentation.

---

## Summary

| Category | Findings |
|---|---|
| Confirmed test failures | 2 (1 consistent, 1 intermittent) |
| Code bugs | 2 |
| Documentation bugs | 5 |
| Package / build issues | 1 |
| Coverage config issues | 1 |

---

## Environment

```
pnpm install   → OK (all deps resolved)
pnpm build     → OK (10 packages built, 2 warnings about missing turbo outputs)
pnpm lint      → OK (0 warnings, 0 errors)
pnpm test      → FAIL (see below)
```

---

## Test Results

### Full Suite (`pnpm test`)

| Package | Result | Notes |
|---|---|---|
| `@flamecast/agent-js` | **FAIL** | `test/flamecast-runtime.test.ts` – 1 test |
| `@flamecast/storage-psql` | **FAIL (intermittent)** | PGLite init timeout – 2 tests; passes on re-run |
| `@flamecast/sdk` | PASS | All 200+ assertions pass when run in batches |
| `flamecast-server` | PASS | 2 tests |
| `@flamecast/example-vercel` | PASS | 1 test |
| `@flamecast/example-cloudflare` | PASS | 1 test |

---

## Bug 1 — `NodeRuntime.fetchSession` Strips Session-Specific WebSocket URL

**Severity: High**  
**File**: `packages/flamecast/src/flamecast/runtime-node.ts:255–257`  
**Failing test**: `examples/agent.js/test/flamecast-runtime.test.ts`  
**Error**:
```
Error: Unexpected server response: 200
  at ClientRequest.<anonymous> ws@8.20.0/lib/websocket.js:918:7
```

### Root Cause

When `NodeRuntime.fetchSession` proxies a `/start` request and gets a successful response, it unconditionally overwrites the `websocketUrl` with the runtime's base URL:

```ts
// packages/flamecast/src/flamecast/runtime-node.ts:253-260
if (originalUrl.pathname.endsWith("/start") && request.method === "POST" && resp.ok) {
  const body = await resp.json();
  const runtimeUrl = new URL(baseUrl);
  body.hostUrl = runtimeUrl.toString().replace(/\/$/, "");
  body.websocketUrl = runtimeUrl.toString().replace(/^http/, "ws").replace(/\/$/, "");  // ← strips session path
  return new Response(JSON.stringify(body), { ... });
}
```

This is correct for the Go session-host binary (which serves all sessions on a single WebSocket endpoint at the root). However, when `NodeRuntime` is instantiated with an explicit URL pointing to an agent.js/Cloudflare Worker, each session has its own Durable Object with a per-session WebSocket path: `ws://host/sessions/{sessionId}`.

The overwrite reduces `ws://127.0.0.1:{port}/sessions/{sessionId}` to `ws://127.0.0.1:{port}`. The Cloudflare Worker does not upgrade WebSocket connections at the root, so it returns `200 OK` instead of `101 Switching Protocols`.

### Reproduction

```ts
const flamecast = new Flamecast({
  storage: await createTestStorage(),
  runtimes: { agentjs: new NodeRuntime("http://worker-host") }, // explicit URL
});

// Worker /start returns { websocketUrl: "ws://worker-host/sessions/abc" }
// NodeRuntime overwrites it to "ws://worker-host" → WebSocket open fails
const session = await flamecast.createSession({ agentTemplateId: "agentjs" });
// session.websocketUrl === "ws://worker-host"  ← wrong
```

### Fix Direction

When using an explicit URL (`this.explicitUrl !== undefined`), preserve the `websocketUrl` from the start response instead of overwriting it:

```ts
if (originalUrl.pathname.endsWith("/start") && request.method === "POST" && resp.ok) {
  const body = await resp.json();
  if (!this.explicitUrl) {
    // Only rewrite for the managed Go binary (shared WS server)
    const runtimeUrl = new URL(baseUrl);
    body.hostUrl = runtimeUrl.toString().replace(/\/$/, "");
    body.websocketUrl = runtimeUrl.toString().replace(/^http/, "ws").replace(/\/$/, "");
  }
  return new Response(JSON.stringify(body), { ... });
}
```

---

## Bug 2 — Ad-hoc `spawn` Sessions Always Default to Provider `"local"`

**Severity: High**  
**Files**:
- `packages/flamecast/src/flamecast/index.ts:1092`
- `packages/flamecast/src/flamecast/session-service.ts:38`

### Root Cause

When creating a session via `POST /api/agents` with a raw `spawn` body (no `agentTemplateId`), `resolveSessionDefinition` hardcodes the runtime provider:

```ts
// packages/flamecast/src/flamecast/index.ts:1092
runtime: { provider: "local" },  // ← always "local"
```

Likewise, `SessionService.startSession` has a fallback:

```ts
// packages/flamecast/src/flamecast/session-service.ts:38
const providerName = opts.runtime.provider ?? "local";  // ← fallback "local"
```

Neither the CLI server nor the apps/server entry point registers a `"local"` runtime. Both register `"default"` as the primary runtime key:

```ts
// apps/server/src/index.ts
runtimes: {
  default: new NodeRuntime(),  // key is "default", not "local"
  docker: new DockerRuntime(),
  ...
}

// packages/flamecast/src/cli-app.ts
runtimes: { default: new NodeRuntime() }  // key is "default", not "local"
```

### Impact

Any user who follows the documented ad-hoc spawn feature and calls:

```json
POST /api/agents
{
  "spawn": { "command": "pnpm", "args": ["exec", "tsx", "./agent.ts"] },
  "name": "Scratch agent"
}
```

Will receive:
```json
{ "error": "Unknown runtime: \"local\". Available: default, docker" }
```

The tests don't catch this because they explicitly use `runtimes: { local: ... }` matching the hardcoded "local".

### Fix Direction

Replace the hardcoded `"local"` fallback with the first registered runtime name, or require an explicit `provider` in ad-hoc spawn requests:

```ts
// In resolveSessionDefinition (index.ts)
const defaultProvider = Object.keys(this.runtimesMap)[0] ?? "local";
runtime: { provider: defaultProvider },
```

---

## Test Failure 1 — `@flamecast/storage-psql` PGLite Initialization Timeout (Intermittent)

**Severity: Medium**  
**Tests**:
- `test/migrations.test.ts > reports pending migrations for a fresh database and becomes ready after migrate`
- `test/storage-alignment.test.ts > stores managed and user templates in pglite-backed storage`

### Root Cause

The `@flamecast/storage-psql` package uses the default vitest `testTimeout` of 5000ms. PGLite database initialization (`createDatabase`) is I/O-bound and takes 4–8 seconds under normal load, which intermittently exceeds the 5000ms limit.

Observed run times:
- First run: `7281ms` (timed out at 5000ms)
- Second run: `4817ms` (passed)

### Fix

Add an explicit timeout to the affected tests, or add a `testTimeout` to the package's vitest config:

```ts
// Affected tests need explicit timeout:
it("reports pending migrations...", async () => { ... }, 30_000);

// Or in a vitest.config.ts for the package:
export default defineConfig({
  test: { testTimeout: 30_000 }
});
```

---

## Test Failure 2 — `@flamecast/agent-js` `flamecast-runtime.test.ts` Timeout (Related to Bug 1)

**Severity: Medium**  
**Test**: `examples/agent.js/test/flamecast-runtime.test.ts`

There is no `vitest.config.ts` for the `@flamecast/agent-js` package, so the default 5000ms timeout applies. `startExampleWorker` waits up to 30 seconds for Wrangler to start. Even if the WebSocket bug (Bug 1) were fixed, the test would time out on slower machines during wrangler startup.

### Fix

Add a `vitest.config.ts` with an appropriate timeout:

```ts
// examples/agent.js/vitest.config.ts
export default defineConfig({
  test: { testTimeout: 60_000 }
});
```

---

## Documentation Bug 1 — `runtimeProviders` Option Does Not Exist

**Severity: High**  
**README lines**: 233–260, 349

The README shows custom providers added via `runtimeProviders`:

```ts
// README (WRONG)
const flamecast = new Flamecast({
  runtimeProviders: {
    remote: {
      async start() {
        const transport = await openRemoteTransportSomehow();
        return { transport, terminate: async () => { ... } };
      },
    },
  },
  ...
});
```

**Actual API** (`FlamecastOptions` in `packages/flamecast/src/flamecast/index.ts:158`):

```ts
// ACTUAL
const flamecast = new Flamecast({
  storage,
  runtimes: {           // ← option is "runtimes", not "runtimeProviders"
    remote: myRuntime,  // ← value is a Runtime instance, not a { start() } object
  },
  ...
});
```

The `start()` / `terminate()` shape shown in the README does not match the `Runtime` interface (`fetchSession`, `dispose`, etc.) from `@flamecast/protocol/runtime`.

---

## Documentation Bug 2 — Constructor Examples Missing Required `runtimes` Field

**Severity: High**  
**README lines**: 337–341

The README shows a minimal Flamecast setup without `runtimes`:

```ts
// README (WRONG — TypeScript error)
const flamecast = new Flamecast({
  storage: await createPsqlStorage({ url: process.env.DATABASE_URL! }),
});
export default flamecast.fetch;
```

`runtimes` is a **required** field in `FlamecastOptions`. This example fails to compile.

---

## Documentation Bug 3 — Non-Existent Constructor Options Listed

**Severity: Medium**  
**README lines**: 349–352

The README constructor options table lists three options that do not exist in `FlamecastOptions`:

| README option | Status |
|---|---|
| `runtimeProviders` | Does not exist; actual name is `runtimes` |
| `handleSignals` | Does not exist in `FlamecastOptions` |
| `runtimeClient` | Does not exist in `FlamecastOptions` |

The actual constructor options are:
```ts
type FlamecastOptions = {
  storage: FlamecastStorage;          // required
  runtimes: Record<string, Runtime>;  // required
  agentTemplates?: AgentTemplate[];
  callbackUrl?: string;
  webhooks?: Omit<WebhookConfig, "id">[];
  onPermissionRequest?: ...;
  onSessionEnd?: ...;
  onAgentMessage?: ...;
  onError?: ...;
}
```

---

## Documentation Bug 4 — HTTP API Table Is Severely Incomplete

**Severity: Medium**  
**README lines**: 403–408

The README only documents 7 of the 26 API endpoints. The following routes exist in `packages/flamecast/src/flamecast/api.ts` but are missing from the table:

| Method | Path | Description |
|---|---|---|
| `PUT` | `/api/agent-templates/:id` | Update a registered template |
| `GET` | `/api/runtimes` | List active runtimes |
| `POST` | `/api/runtimes/:typeName/start` | Start a runtime instance |
| `POST` | `/api/runtimes/:instanceName/stop` | Stop a runtime instance |
| `POST` | `/api/runtimes/:instanceName/pause` | Pause a runtime instance |
| `GET` | `/api/runtimes/:instanceName/files` | Fetch a file from runtime workspace |
| `GET` | `/api/runtimes/:instanceName/fs/snapshot` | List runtime filesystem |
| `GET` | `/api/agents/:agentId/stream` | SSE event stream for an agent |
| `POST` | `/api/agents/:agentId/prompts` | Send a prompt to an agent |
| `POST` | `/api/agents/:agentId/events` | Post a session-host callback event |
| `POST` | `/api/agents/:agentId/permissions/:requestId` | Respond to a permission request |
| `GET` | `/api/agents/:agentId/queue` | Get the prompt queue state |
| `DELETE` | `/api/agents/:agentId/queue/:queueId` | Cancel a specific queued prompt |
| `DELETE` | `/api/agents/:agentId/queue` | Clear the entire queue |
| `PUT` | `/api/agents/:agentId/queue` | Reorder the prompt queue |
| `POST` | `/api/agents/:agentId/queue/pause` | Pause queue processing |
| `POST` | `/api/agents/:agentId/queue/resume` | Resume queue processing |
| `GET` | `/api/agents/:agentId/files` | Fetch a file from agent workspace |
| `GET` | `/api/agents/:agentId/fs/snapshot` | List agent filesystem |

---

## Documentation Bug 5 — Built-in Templates Section References Wrong File and Wrong Provider

**Severity: Low**  
**README lines**: 142–161

The README states:

> Built-in templates live in `packages/flamecast/src/flamecast/agent-templates.ts`

That file does not exist. Actual locations:
- `packages/flamecast-psql/src/default-templates.ts` — default templates for PGLite/Postgres-backed deployments
- `apps/server/src/agent-templates.ts` — templates used by the reference server

The README shows `"local"` as the built-in provider name, but actual templates use `"default"`. The Docker template shape shown (`image`, `dockerfile`) is also out of date — current templates use `setup` scripts, not Docker image references.

---

## Package / Build Issue — `@flamecast/sdk/client` Export Points to TypeScript Source

**Severity: Low**  
**File**: `packages/flamecast/package.json`

```json
"./client": {
  "types": "./src/client/api.ts",
  "import": "./src/client/api.ts"
}
```

`src/client/api.ts` is excluded from `tsconfig.package.json`'s `include` list, so it is **never compiled to `dist/`**. The export points to a raw TypeScript file. This works inside the Vite-based client app (which can handle TypeScript source directly) but would break for any external npm consumer of `@flamecast/sdk/client`.

The `types` field should point to a `.d.ts` file; the `import` field should point to the compiled `.js` output.

---

## Coverage Config Issue — Stale Exclusion Paths

**Severity: Low**  
**File**: `packages/flamecast/vitest.integration.config.ts`

The coverage `exclude` list contains paths that do not exist:

```ts
exclude: [
  "src/flamecast/storage.ts",   // exists ✓
  "src/flamecast/runtime.ts",   // DOES NOT EXIST
  "src/flamecast/runtimes/node.ts",   // DOES NOT EXIST (actual: src/flamecast/runtime-node.ts)
  "src/flamecast/session-service.ts", // exists ✓
  "src/flamecast/agent.ts",     // exists ✓
  "src/flamecast/client.ts",    // DOES NOT EXIST
]
```

The actual `NodeRuntime` file is `src/flamecast/runtime-node.ts`. The stale paths mean coverage is not excluded for the right files, and the coverage thresholds (55% branches, 60% functions/lines) may be inaccurate.

---

## What Works Correctly

- **Build**: Full monorepo builds cleanly (`pnpm build`)
- **Linting**: Zero lint warnings or errors (`pnpm lint`)
- **Core API surface**: All 35 API surface tests pass (`test/api-server/api-surface.test.ts`)
- **Session lifecycle**: Create → get → list → terminate → verify killed all work correctly
- **Permission flow**: `onPermissionRequest` handler wiring, `allow()`/`deny()` helpers work
- **Multi-session isolation**: Multiple concurrent sessions tracked independently
- **Runtime dispatch**: Templates correctly route to the right runtime provider
- **Stateless control plane**: Session recovery after server restart works
- **Webhook delivery**: Webhook engine delivers events with retry logic
- **Event bus**: History buffering, SSE stream, `onEvent`/`onSessionCreated`/`onSessionTerminated`
- **Queue management**: Proxy to session-host for queue pause/resume/reorder
- **CLI commands**: `flamecast serve`, `flamecast db status`, `flamecast db migrate`, `flamecast db studio` all parse correctly
- **PGLite storage**: Sessions, templates, runtime instances, migrations all work
- **`NodeRuntime` (Go binary mode)**: File preview, filesystem snapshot, process lifecycle work
- **`NodeRuntime` (explicit URL mode)**: HTTP proxying works; only WebSocket URL rewrite is broken (Bug 1)
- **`@flamecast/agent-js` e2e tests**: Direct session-host access without Flamecast works (3/4 tests pass)

---

## Reproduction Steps for Critical Bugs

### Bug 1 (WebSocket URL)

```bash
cd examples/agent.js
pnpm vitest run test/flamecast-runtime.test.ts
# → Error: Unexpected server response: 200
```

### Bug 2 (Ad-hoc spawn provider)

```bash
# Start the default server
pnpm dev:server

# Attempt ad-hoc spawn
curl -X POST http://localhost:3001/api/agents \
  -H "Content-Type: application/json" \
  -d '{"spawn":{"command":"echo","args":["hello"]},"name":"test"}'
# → {"error": "Unknown runtime: \"local\". Available: default"}
```

### Intermittent storage timeout

```bash
cd packages/flamecast-psql
pnpm vitest run test/migrations.test.ts
# May time out on first run; usually passes on retry
```
