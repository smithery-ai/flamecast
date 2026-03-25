/**
 * A Runtime knows how to ensure a SessionHost exists for a given session
 * and how to route HTTP/WS traffic to it.
 *
 * Intentionally minimal for MVP. Covers start/forward/terminate via HTTP
 * semantics. May be split into explicit lifecycle methods later.
 */
// oxlint-disable-next-line no-unused-vars -- TConfig is used by RuntimeConfigFor via `Runtime<infer C>`
export interface Runtime<TConfig extends Record<string, unknown> = {}> {
  fetchSession(sessionId: string, request: Request): Promise<Response>;
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Generic helpers — constrain template `runtime.provider` to registered names
// ---------------------------------------------------------------------------

/** Extract string keys from a runtime registry `R`. */
export type RuntimeNames<R> = Extract<keyof R, string>;

/**
 * Union of valid runtime config objects for a given registry.
 * Each branch carries the `provider` key narrowed to the specific runtime name
 * plus the runtime's own config fields.
 */
export type RuntimeConfigFor<R extends Record<string, Runtime<Record<string, unknown>>>> = {
  [K in keyof R]: R[K] extends Runtime<infer C> ? { provider: K; setup?: string } & C : never;
}[keyof R];

/** Minimal session context exposed to event handlers. */
export interface SessionContext<R extends Record<string, Runtime<Record<string, unknown>>>> {
  id: string;
  agentName: string;
  runtime: RuntimeNames<R>;
  spawn: { command: string; args: string[] };
  startedAt: string;
}

/** Reason a session ended. */
export type SessionEndReason = "terminated" | "error" | "idle_timeout" | "agent_exit";
