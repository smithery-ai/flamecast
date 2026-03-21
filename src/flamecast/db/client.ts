import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePgLite } from "drizzle-orm/pglite";
import { migrate as migratePgLite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { PsqlAppDb } from "../state-managers/psql/types.js";
import { PSQL_MIGRATIONS_FOLDER } from "../state-managers/psql/migrations-path.js";
import * as schema from "../state-managers/psql/schema.js";

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
  /** PGLite data directory when no Postgres URL is set. Default: `FLAMECAST_PGLITE_DIR` or `<cwd>/.flamecast/pglite`. */
  pgliteDataDir?: string;
};

/**
 * Connects to **Postgres** when `FLAMECAST_POSTGRES_URL` is set; otherwise **PGLite** on disk.
 * Applies Drizzle migrations from `flamecast/state-managers/psql/migrations`.
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
  const client = await PGlite.create(dataDir);
  const db = drizzlePgLite({ client, schema });
  await migratePgLite(db, { migrationsFolder });
  return {
    db,
    close: async () => {
      await client.close();
    },
  };
}
