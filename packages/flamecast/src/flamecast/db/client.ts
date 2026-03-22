import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePgLite } from "drizzle-orm/pglite";
import { migrate as migratePgLite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { PsqlAppDb } from "../storage/psql/types.js";
import { PSQL_MIGRATIONS_FOLDER } from "../storage/psql/migrations-path.js";
import * as schema from "../storage/psql/schema.js";

export type AppDb = PsqlAppDb;

export type DatabaseBundle = {
  db: AppDb;
  /** Postgres pool end, or PGlite close. */
  close: () => Promise<void>;
};

export { schema as psqlSchema };

function postgresConnectionString(): string | undefined {
  const url = process.env.FLAMECAST_POSTGRES_URL;
  const t = url?.trim();
  return t || undefined;
}

export type CreateDatabaseOptions = {
  /**
   * PGLite data directory when no Postgres URL is set.
   * Default: `FLAMECAST_PGLITE_DIR` or `<cwd>/.flamecast/pglite`.
   * Falls back to `ACP_PGLITE_DIR` for legacy installs.
   */
  pgliteDataDir?: string;
};

function toPgliteStartupError(dataDir: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Aborted()")) {
    return new Error(
      `Failed to open the local PGlite database at "${dataDir}". ` +
        "This usually means another Flamecast process is already using that directory, " +
        "or it was left locked after a crash. Stop the other dev server, or set " +
        "FLAMECAST_PGLITE_DIR to a different path before starting Flamecast again.",
    );
  }

  return error instanceof Error ? error : new Error(message);
}

/**
 * Connects to **Postgres** when `FLAMECAST_POSTGRES_URL` is set; otherwise **PGLite** on disk.
 * Applies Drizzle migrations from `flamecast/storage/psql/migrations`.
 */
export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<DatabaseBundle> {
  const dbUrl = postgresConnectionString();
  const migrationsFolder = PSQL_MIGRATIONS_FOLDER;

  if (dbUrl) {
    const pool = new Pool({ connectionString: dbUrl });
    const db = drizzleNodePg({ client: pool, schema });
    await migrateNodePg(db, { migrationsFolder });
    return {
      db,
      close: async () => {
        await pool.end();
      },
    };
  }

  console.warn("postgres url not found, falling back to pglite");

  const dataDir = path.resolve(
    options.pgliteDataDir ??
      process.env.FLAMECAST_PGLITE_DIR ??
      process.env.ACP_PGLITE_DIR ??
      path.join(process.cwd(), ".flamecast", "pglite"),
  );
  await mkdir(dataDir, { recursive: true });
  let client: Awaited<ReturnType<typeof PGlite.create>>;
  try {
    client = await PGlite.create(dataDir);
  } catch (error) {
    throw toPgliteStartupError(dataDir, error);
  }
  const db = drizzlePgLite({ client, schema });
  await migratePgLite(db, { migrationsFolder });
  return {
    db,
    close: async () => {
      await client.close();
    },
  };
}
