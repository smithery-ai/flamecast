/**
 * A Runtime knows how to ensure a SessionHost exists for a given session
 * and how to route HTTP/WS traffic to it.
 *
 * Intentionally minimal for MVP. Covers start/forward/terminate via HTTP
 * semantics. May be split into explicit lifecycle methods later.
 */
// oxlint-disable-next-line no-unused-vars -- TConfig is used by RuntimeConfigFor via `Runtime<infer C>`
export interface Runtime<TConfig extends Record<string, unknown> = {}> {
  /** If true, only a single instance is allowed (e.g., local/node runtimes). Default: false. */
  readonly onlyOne?: boolean;
  fetchSession(sessionId: string, request: Request): Promise<Response>;
  /**
   * Proxy an instance-scoped request directly to the runtime instance.
   *
   * This is intended for runtime-level surfaces such as filesystem browsing
   * or aggregate traces that should exist independently of any one session.
   */
  fetchInstance?(instanceId: string, request: Request): Promise<Response>;
  /** Start (or resume) a runtime instance. Creates the instance if it doesn't exist. */
  start?(instanceId: string): Promise<void>;
  /** Stop a specific runtime instance and tear down its resources. */
  stop?(instanceId: string): Promise<void>;
  /** Pause a runtime instance (sessions survive, resources freeze). */
  pause?(instanceId: string): Promise<void>;
  /** Delete a runtime instance and permanently remove its resources. */
  delete?(instanceId: string): Promise<void>;
  /** Query the live status of an instance from the actual runtime (e.g. Docker). */
  getInstanceStatus?(instanceId: string): Promise<"running" | "stopped" | "paused" | undefined>;
  /** Return the WebSocket URL for a running instance's runtime-host. */
  getWebsocketUrl?(instanceId: string): string | undefined;
  dispose?(): Promise<void>;
  /**
   * Return runtime-specific metadata for a session that should be persisted
   * for recovery after a server restart. Called after session creation.
   */
  getRuntimeMeta?(sessionId: string): Record<string, unknown> | null;
  /**
   * Re-register a previously-running session after a server restart.
   *
   * Called during recovery with the runtime-specific metadata that was persisted
   * when the session was originally created. Returns `true` if the session is
   * still alive and was successfully re-registered, `false` otherwise.
   *
   * Runtimes that don't support reconnection can omit this method; the recovery
   * logic will fall back to a health-check probe against the persisted hostUrl.
   */
  reconnect?(sessionId: string, runtimeMeta: Record<string, unknown> | null): Promise<boolean>;
}

/** Persisted state of a runtime instance. */
export interface RuntimeInstance {
  name: string;
  typeName: string;
  status: "running" | "stopped" | "paused";
  /** WebSocket URL of the runtime-host for this instance (set when running). */
  websocketUrl?: string;
}

/** Aggregated info for a runtime type and its instances. */
export interface RuntimeInfo {
  typeName: string;
  onlyOne: boolean;
  instances: RuntimeInstance[];
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
