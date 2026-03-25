# 2.6 — Update Entry Points + Dev Workflow

**Goal:** `apps/server` is the primary local dev entry point (Node + Hono + LocalRuntime + PGLite). `apps/worker` is the deployed serverless entry point. `alchemy.run.ts` is deployment-only.

**Depends on:** 2.2 (LocalRuntime), 2.3 (RemoteRuntime), 2.5 (Flamecast constructor)

## What to do

### `apps/server/src/index.ts` (primary local dev)

```typescript
import { Flamecast } from "@flamecast/sdk";
import { LocalRuntime } from "@flamecast/sdk/runtimes/local";
import { createPsqlStorage } from "@flamecast/storage-psql";

const flamecast = new Flamecast({
  storage: await createPsqlStorage(), // PGLite by default
  runtimes: {
    local: new LocalRuntime(),
  },
});

await flamecast.listen(3001);
```

`Flamecast.listen()` already uses `@hono/node-server` internally.

### `apps/worker/src/index.ts` (deployed serverless)

```typescript
import { Flamecast } from "@flamecast/sdk";
import { RemoteRuntime } from "@flamecast/sdk/runtimes/remote";
import { createPsqlStorage } from "@flamecast/storage-psql";

const flamecast = new Flamecast({
  storage: await createPsqlStorage({ url: env.DATABASE_URL }),
  runtimes: {
    local: new RemoteRuntime({ url: env.LOCAL_RUNTIME_URL }),
  },
});

export default flamecast.app;
```

### `alchemy.run.ts` (deployment-only)

No longer needed for local dev. Becomes deployment orchestration:

- Provision managed Postgres (Neon, etc.)
- Publish SessionHost Docker image
- Deploy Hono app to CF Workers / Vercel
- Spawn `LocalRuntime.listen()` as sidecar for serverless targets

### Root `package.json` scripts

```json
{
  "dev": "turbo dev", // runs apps/server + Vite (no Alchemy)
  "dev:server": "turbo dev --filter=@acp/server",
  "dev:client": "turbo dev --filter=@flamecast/sdk",
  "alchemy:dev": "alchemy dev", // optional: test deployed-like stack locally
  "alchemy:deploy": "alchemy deploy"
}
```

## Files

- **Modify:** `apps/server/src/index.ts`
- **Modify:** `apps/worker/src/index.ts`
- **Modify:** `alchemy.run.ts` (remove local dev orchestration)
- **Modify:** root `package.json` (scripts)

## Test Coverage

Integration tests:

- **Local dev smoke test:** Start `apps/server`. `GET /api/health` returns 200. `GET /api/agent-templates` returns seeded templates. `POST /api/agents` creates a session. WebSocket connect succeeds. Send prompt. Verify events stream back.
- **Dev script verification:** Verify `pnpm dev` script works end-to-end (can be a manual test or CI smoke test).

## Acceptance criteria

- `pnpm dev` → single Node process + Vite, no Alchemy, no Miniflare
- `http://localhost:3001/api/health` responds
- `http://localhost:3000` loads the React UI
- Creating a session from the UI works end-to-end
- `pnpm alchemy:deploy` still works for deployment
