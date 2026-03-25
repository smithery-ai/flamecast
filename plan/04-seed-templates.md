# 1.4 — Seed Local Templates (Gap #5)

**Goal:** Local dev has both Example agent and Codex ACP templates available, matching the baseline.

**Depends on:** Nothing (can start immediately)

## Root cause

`seed.ts` with `SEED_LOCAL=true` only seeds the Example agent. Codex ACP is filtered out because it has a `setup` field in the deployed config.

## What to do

Update `packages/flamecast-psql/src/seed.ts` to include local-compatible templates:

```typescript
const LOCAL_TEMPLATES: AgentTemplate[] = [
  {
    id: "example",
    name: "Example agent",
    spawn: { command: "pnpm", args: ["exec", "tsx", resolvedAgentPath] },
    runtime: { provider: "local" },
  },
  {
    id: "codex",
    name: "Codex ACP",
    spawn: { command: "pnpm", args: ["dlx", "@zed-industries/codex-acp"] },
    runtime: { provider: "local" },
  },
];
```

Key: use `provider: "local"` for local dev templates. No `setup` field needed — these commands are available directly via pnpm. Deployed templates (seeded separately) can use different providers with `setup` fields.

## Files

- **Modify:** `packages/flamecast-psql/src/seed.ts`

## Test Coverage

Integration tests (real Flamecast instance + seeded database, no mocks):

1. **After seeding:** `GET /api/agent-templates` returns both Example agent and Codex ACP
2. **Template shape:** Each template has valid `{ id, name, spawn, runtime }` with `runtime.provider === "local"`
3. **Start session from template:** `POST /api/agents { agentTemplateId: "example" }` succeeds and returns active session

## Acceptance criteria

- `pnpm dev` → home page shows both "Example agent" and "Codex ACP" template cards
- Both "Start session" buttons work
- `GET /api/agent-templates` returns 2 templates
