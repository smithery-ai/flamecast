# 2.1 — Runtime Interface + Types

**Goal:** Define the `Runtime` interface with config type parameter, plus all supporting generic types for the typed constructor API.

**Depends on:** Nothing (can start immediately, parallel with 2.2/2.3)

## What to do

Create `packages/flamecast/src/flamecast/runtime.ts`:

```typescript
import type { ZodType } from "zod";

export interface Runtime<TConfig extends Record<string, unknown> = {}> {
  readonly configSchema?: ZodType<TConfig>;
  fetchSession(sessionId: string, request: Request): Promise<Response>;
  dispose?(): Promise<void>;
}

export type RuntimeNames<R> = Extract<keyof R, string>;

export type RuntimeConfigFor<R extends Record<string, Runtime<any>>> = {
  [K in keyof R]: R[K] extends Runtime<infer C> ? { provider: K; setup?: string } & C : never;
}[keyof R];

export interface SessionContext<R extends Record<string, Runtime<any>>> {
  id: string;
  agentName: string;
  runtime: RuntimeNames<R>;
  spawn: AgentSpawn;
  startedAt: string;
}

export type SessionEndReason = "terminated" | "error" | "idle_timeout" | "agent_exit";

export interface FlamecastEventHandlers<R extends Record<string, Runtime<any>>> {
  onSessionStart?: (session: SessionContext<R>) => Promise<void>;
  onSessionEnd?: (session: SessionContext<R>, reason: SessionEndReason) => Promise<void>;
  onError?: (session: SessionContext<R>, error: Error) => Promise<void>;
  onPermissionRequest?: (
    session: SessionContext<R>,
    request: PermissionRequest,
  ) => Promise<PermissionResponse | undefined>;
  onPrompt?: (session: SessionContext<R>, prompt: { text: string }) => Promise<void>;
  onToolCall?: (
    session: SessionContext<R>,
    toolCall: { title: string; kind: string; toolCallId: string },
  ) => Promise<void>;
  onAgentMessage?: (session: SessionContext<R>, message: { text: string }) => Promise<void>;
}
```

Delete `packages/flamecast/src/flamecast/data-plane.ts`.

## Files

- **New:** `packages/flamecast/src/flamecast/runtime.ts`
- **Delete:** `packages/flamecast/src/flamecast/data-plane.ts`
- **Update:** package exports if needed

## Test Coverage

No runtime tests — types only. Verified at compile time. The `Runtime` interface contract is tested through `LocalRuntime` and `RemoteRuntime` integration tests.

## Acceptance criteria

- Types compile
- `Runtime<{}>`, `Runtime<{ template: string }>` both valid
- `RuntimeConfigFor` produces correct discriminated unions
- `SessionContext.runtime` is narrowed to `keyof R`
- Deleted `data-plane.ts` doesn't break other imports (update any references)
