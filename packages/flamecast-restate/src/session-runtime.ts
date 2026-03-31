/**
 * SessionRuntime — abstract interface for durable session operations.
 *
 * Decouples session lifecycle logic from the underlying runtime (Restate, etc.).
 * No Restate imports allowed in this file.
 */

export interface SessionRuntime {
  /** Durable step — journaled, replayed on retry. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;

  /** Create a durable promise resolved externally (for permissions). */
  awakeable<T = unknown>(): { id: string; promise: Promise<T> };

  /** KV state scoped to this session. */
  state: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): void;
    clear(key: string): void;
    clearAll(): void;
  };

  /** Publish event to pubsub topic. */
  emit(topic: string, event: unknown): void;

  /** Fire-and-forget to a stateless service handler. */
  sendService(service: string, handler: string, payload: unknown): void;

  /** Deterministic timestamp (journaled). */
  now(): Promise<string>;

  /** The unique key for this session (Virtual Object key). */
  readonly key: string;
}
