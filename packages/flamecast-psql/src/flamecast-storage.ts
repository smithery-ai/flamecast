import type { FlamecastStorage } from "@flamecast/protocol";

export type {
  FlamecastStorage,
  SessionMeta,
  SessionRuntimeInfo,
  StoredSession,
} from "@flamecast/protocol";

/** Drizzle-backed Flamecast storage surface. */
export interface PsqlFlamecastStorage extends FlamecastStorage {}
