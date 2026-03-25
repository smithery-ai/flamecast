import type { FlamecastStorage } from "@flamecast/sdk";
import { createDatabase } from "./db.js";
import { createStorageFromDb } from "./storage.js";
import { defaultAgentTemplates } from "./default-templates.js";

export type PsqlStorageOptions = {
  /** Postgres connection URL. If omitted, falls back to embedded PGLite. */
  url?: string;
  /** PGLite data directory (only used when no URL is provided). */
  dataDir?: string;
  /** Seed default agent templates on startup. Defaults to `true` when using PGLite (no URL). */
  seedDefaults?: boolean;
};

/**
 * Create a {@link FlamecastStorage} backed by PostgreSQL (or embedded PGLite).
 *
 * When using PGLite (no `url`), builtin agent templates are auto-seeded unless
 * `seedDefaults: false` is passed. When using Postgres, templates are not seeded
 * unless `seedDefaults: true` is explicitly set.
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
): Promise<FlamecastStorage> {
  const { db } = await createDatabase(options);
  const storage = createStorageFromDb(db);

  const shouldSeed = options.seedDefaults ?? !options.url;
  if (shouldSeed) {
    await storage.seedAgentTemplates(defaultAgentTemplates);
  }

  return storage;
}

export { createStorageFromDb } from "./storage.js";
export type { PsqlAppDb } from "./types.js";
export type { DatabaseBundle } from "./db.js";
export { createDatabase } from "./db.js";
export { defaultAgentTemplates } from "./default-templates.js";
