# 2.5 — Typed Flamecast Constructor + Event Handlers

**Goal:** Make `Flamecast` generic over the runtime registry. TypeScript infers runtime names and config shapes from the constructor, constraining templates and handlers.

**Depends on:** 2.1 (Runtime + types), 2.4 (SessionService)

## What to do

Update `packages/flamecast/src/flamecast/index.ts`:

1. Make `Flamecast` class generic over `R extends Record<string, Runtime<any>>`
2. Change `FlamecastOptions` to use `runtimes: R` instead of `runtimeProviders: RuntimeProviderRegistry`
3. Add `FlamecastEventHandlers<R>` to the options (extend)
4. Constrain `agentTemplates` to `RuntimeConfigFor<R>`
5. Wire event handlers through to `SessionService`
6. Remove `runtimeClient` option (superseded by `SessionService` + `Runtime`)

## Breaking changes from main branch API

| Before (main)                                | After                          | Reason                                   |
| -------------------------------------------- | ------------------------------ | ---------------------------------------- |
| `runtimeProviders?: RuntimeProviderRegistry` | `runtimes: R`                  | SMI-1680 — named runtime instances       |
| `runtimeClient?: RuntimeClient`              | Removed                        | Replaced by `Runtime` + `SessionService` |
| `agentTemplates` untyped runtime             | `runtime: RuntimeConfigFor<R>` | Type-safe provider + config              |

`storage?: FlamecastStorage` and `handleSignals?: boolean` are unchanged.

## Files

- **Modify:** `packages/flamecast/src/flamecast/index.ts`
- **Update:** any re-exports (e.g., `RuntimeProvider` → `Runtime`)

## Test Coverage

Primarily compile-time verification (generics, type narrowing). Runtime tests covered by SessionService tests. One integration test worth adding:

- **Constructor wiring:** `new Flamecast({ runtimes: { local: new LocalRuntime() } })`. `POST /api/agents { runtime: { provider: "local" } }` creates a session. Verify full lifecycle works through the Hono app (session created, health check passes, terminate succeeds).

## Acceptance criteria

- `new Flamecast({ runtimes: { local: new LocalRuntime(...) } })` compiles
- Template with `{ provider: "nonexistent" }` is a type error
- Template with missing runtime-specific config is a type error
- Event handlers receive `SessionContext` with narrowed `runtime` type
- `onPermissionRequest` return type is `Promise<PermissionResponse | undefined>`
- Existing tests still pass (update constructor calls)
