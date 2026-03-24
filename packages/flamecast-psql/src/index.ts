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
 * Create a {@link FlamecastStorage} backed by PostgreSQL (or embedded PGLite).
 *
 * @example
 * ```ts
 * // Postgres
 * const storage = await createPsqlStorage({ url: "postgres://localhost/flamecast" });
 *
 * // PGLite (default)
 * const storage = await createPsqlStorage();
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
