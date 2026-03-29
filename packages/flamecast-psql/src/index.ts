import { createDatabase, resolveDatabaseOptions } from "./db.js";
import { createStorageFromDb } from "./storage.js";
import { defaultAgentTemplates } from "./default-templates.js";
import type { PsqlFlamecastStorage } from "./flamecast-storage.js";

export type PsqlStorageOptions = {
  /** Postgres connection URL. If omitted, falls back to `DATABASE_URL`/`POSTGRES_URL`, then embedded PGLite. */
  url?: string;
  /** PGLite data directory (only used when no URL is provided). */
  dataDir?: string;
  /** Seed default agent templates on startup. Defaults to `true` when using PGLite (no URL). */
  seedDefaults?: boolean;
};

/**
 * Create a Drizzle-backed Flamecast storage backed by PostgreSQL (or embedded PGLite).
 *
 * The database schema must already exist, for example via `flamecast db migrate`.
 *
 * When using PGLite (no URL, `DATABASE_URL`, or `POSTGRES_URL`), builtin agent
 * templates are auto-seeded unless `seedDefaults: false` is passed. When using
 * Postgres, templates are not seeded unless `seedDefaults: true` is explicitly set.
 *
 * @example
 * ```ts
 * // Postgres (no auto-seed)
 * const storage = await createPsqlStorage({ url: "postgres://localhost/flamecast" });
 *
 * // PGLite (auto-seeds default templates)
 * const storage = await createPsqlStorage();
 * ```
 */
export async function createPsqlStorage(
  options: PsqlStorageOptions = {},
): Promise<PsqlFlamecastStorage> {
  const { db } = await createDatabase(options);
  const storage = createStorageFromDb(db);

  const resolved = resolveDatabaseOptions(options);
  const shouldSeed = options.seedDefaults ?? !("url" in resolved);
  if (shouldSeed) {
    await storage.seedAgentTemplates(defaultAgentTemplates);
  }

  return storage;
}

export { createStorageFromDb } from "./storage.js";
export type { PsqlAppDb } from "./types.js";
export type { DatabaseBundle, DatabaseOptions, ResolvedDatabaseOptions } from "./db.js";
export type {
  PsqlFlamecastStorage,
  SessionMeta,
  SessionRuntimeInfo,
  StoredSession,
} from "./flamecast-storage.js";
export {
  createDatabase,
  migrateDatabase,
  resolveDatabaseOptions,
  resolvePgliteDataDir,
} from "./db.js";
export { defaultAgentTemplates } from "./default-templates.js";
export { PSQL_MIGRATIONS_FOLDER, PSQL_SCHEMA_FILE } from "./migrations-path.js";
