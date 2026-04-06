import type { FlamecastStorage } from "@flamecast/protocol";
import {
  assertDatabaseReady,
  createDatabase,
  getMigrationStatus,
  migrateDatabase,
  resolvePsqlConnection,
} from "./db.js";
import { createStorageFromDb } from "./storage.js";
import { defaultAgentTemplates } from "./default-templates.js";
import { PSQL_SCHEMA_FILE } from "./migrations-path.js";
import type {
  DatabaseBundle,
  MigrationRecord,
  MigrationStatus,
  PsqlConnectionOptions,
} from "./db.js";

export type PsqlStorageOptions = {
  /** Postgres connection URL. If omitted, falls back to embedded PGLite. */
  url?: string;
  /** PGLite data directory (only used when no URL is provided). */
  dataDir?: string;
  /** Seed default agent templates on startup. Defaults to `true` when using PGLite (no URL). */
  seedDefaults?: boolean;
};

export type PsqlDatabase = {
  kind: "psql";
  open(): Promise<DatabaseBundle>;
  createStorage(options?: Pick<PsqlStorageOptions, "seedDefaults">): Promise<FlamecastStorage>;
  getMigrationStatus(): Promise<MigrationStatus>;
  migrate(): Promise<{ applied: MigrationRecord[]; status: MigrationStatus }>;
  getStudioConfig(): DrizzleStudioConfig;
};

async function withDatabase<T>(
  options: PsqlConnectionOptions,
  run: (bundle: DatabaseBundle) => Promise<T>,
): Promise<T> {
  const bundle = await createDatabase(options);

  try {
    return await run(bundle);
  } finally {
    await bundle.close();
  }
}

/**
 * Create a Drizzle-backed Flamecast storage backed by PostgreSQL (or embedded PGLite).
 *
 * Startup is read-only with respect to schema: pending migrations must be
 * applied explicitly via `migrateDatabase()` or the `flamecast db migrate` CLI.
 *
 * When using PGLite (no `url`), builtin agent templates are auto-seeded unless
 * `seedDefaults: false` is passed. When using Postgres, templates are not
 * seeded unless `seedDefaults: true` is explicitly set.
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
  const bundle = await createDatabase(options);

  try {
    await assertDatabaseReady(bundle);
    const storage = createStorageFromDb(bundle.db);

    const shouldSeed = options.seedDefaults ?? !options.url;
    if (shouldSeed) {
      await storage.seedAgentTemplates(defaultAgentTemplates);
    }

    return storage;
  } catch (error) {
    await bundle.close().catch(() => {});
    throw error;
  }
}

export function createPsqlDatabase(options: PsqlConnectionOptions = {}): PsqlDatabase {
  return {
    kind: "psql",
    open: () => createDatabase(options),
    createStorage: (storageOptions = {}) => createPsqlStorage({ ...options, ...storageOptions }),
    getMigrationStatus: () => withDatabase(options, (bundle) => getMigrationStatus(bundle)),
    migrate: () => withDatabase(options, (bundle) => migrateDatabase(bundle)),
    getStudioConfig: () => getDrizzleStudioConfig(options),
  };
}

export type DrizzleStudioConfig =
  | {
      dialect: "postgresql";
      schema: string;
      dbCredentials: { url: string };
    }
  | {
      dialect: "postgresql";
      driver: "pglite";
      schema: string;
      dbCredentials: { url: string };
    };

export function getDrizzleStudioConfig(
  options: Pick<PsqlStorageOptions, "url" | "dataDir"> = {},
): DrizzleStudioConfig {
  const connection = resolvePsqlConnection(options);

  if (connection.driver === "postgres") {
    return {
      dialect: "postgresql",
      schema: PSQL_SCHEMA_FILE,
      dbCredentials: {
        url: connection.url,
      },
    };
  }

  return {
    dialect: "postgresql",
    driver: "pglite",
    schema: PSQL_SCHEMA_FILE,
    dbCredentials: {
      url: connection.dataDir,
    },
  };
}

export { createStorageFromDb } from "./storage.js";
export type { PsqlAppDb } from "./types.js";
export type { PsqlConnectionOptions, ResolvedPsqlConnection } from "./db.js";
export type { DatabaseBundle, MigrationRecord, MigrationStatus } from "./db.js";
export type {
  FlamecastStorage,
  SessionMeta,
  SessionRuntimeInfo,
  StoredSession,
} from "@flamecast/protocol";
export {
  assertDatabaseReady,
  createDatabase,
  getMigrationStatus,
  getMigrationStatusMessage,
  migrateDatabase,
  resolvePsqlConnection,
} from "./db.js";
export { defaultAgentTemplates } from "./default-templates.js";
