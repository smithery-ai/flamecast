import type { FlamecastStorage } from "@flamecast/sdk";
import { createDatabase } from "./db.js";
import { createStorageFromDb } from "./storage.js";

export type PsqlStorageOptions = {
  /** Postgres connection URL. If omitted, falls back to embedded PGLite. */
  url?: string;
  /** PGLite data directory (only used when no URL is provided). */
  dataDir?: string;
};

/**
 * Create a {@link FlamecastStorage} backed by PostgreSQL.
 *
 * Connects via the standard Postgres wire protocol. Works with any
 * Postgres-compatible server: PlanetScale, Neon, pglite-server, etc.
 *
 * @example
 * ```ts
 * const storage = await createPsqlStorage({
 *   url: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
 * });
 * ```
 */
export async function createPsqlStorage(
  options: PsqlStorageOptions = {},
): Promise<FlamecastStorage> {
  const { db } = await createDatabase(options);
  return createStorageFromDb(db);
}

export { createStorageFromDb } from "./storage.js";
export type { PsqlAppDb } from "./types.js";
export type { DatabaseBundle } from "./db.js";
export { createDatabase } from "./db.js";
