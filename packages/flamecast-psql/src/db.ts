import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePgLite } from "drizzle-orm/pglite";
import { migrate as migratePgLite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { PsqlAppDb } from "./types.js";
import { PSQL_MIGRATIONS_FOLDER } from "./migrations-path.js";
import * as schema from "./schema.js";

export type DatabaseOptions = {
  url?: string;
  dataDir?: string;
};

export type ResolvedDatabaseOptions = { url: string } | { dataDir: string };

export type DatabaseBundle = {
  db: PsqlAppDb;
  /** Postgres pool end, or PGlite close. */
  close: () => Promise<void>;
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

export function resolvePgliteDataDir(dataDir?: string): string {
  return path.resolve(
    dataDir ?? process.env.FLAMECAST_PGLITE_DIR ?? path.join(process.cwd(), ".flamecast", "pglite"),
  );
}

/**
 * Resolve the active Flamecast database connection from explicit options or
 * the standard environment variables used by the server and CLI.
 */
export function resolveDatabaseOptions(options: DatabaseOptions = {}): ResolvedDatabaseOptions {
  if (options.url) {
    return { url: options.url };
  }

  if (options.dataDir) {
    return { dataDir: resolvePgliteDataDir(options.dataDir) };
  }

  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (url) {
    return { url };
  }

  return { dataDir: resolvePgliteDataDir() };
}

/** Connect to **Postgres** when a URL is provided; otherwise **PGLite** on disk. */
export async function createDatabase(options: DatabaseOptions = {}): Promise<DatabaseBundle> {
  const resolved = resolveDatabaseOptions(options);

  if ("url" in resolved) {
    const pool = new Pool({ connectionString: resolved.url });
    const db = drizzleNodePg({ client: pool, schema });
    return {
      db,
      close: async () => {
        await pool.end();
      },
    };
  }

  const dataDir = resolved.dataDir;
  await mkdir(dataDir, { recursive: true });
  let client: Awaited<ReturnType<typeof PGlite.create>>;
  try {
    client = await PGlite.create(dataDir);
  } catch (error) {
    throw toPgliteStartupError(dataDir, error);
  }
  const db = drizzlePgLite({ client, schema });
  return {
    db,
    close: async () => {
      await client.close();
    },
  };
}

/** Apply bundled Drizzle migrations to the active Flamecast database. */
export async function migrateDatabase(options: DatabaseOptions = {}): Promise<void> {
  const resolved = resolveDatabaseOptions(options);
  const migrationsFolder = PSQL_MIGRATIONS_FOLDER;

  if ("url" in resolved) {
    const pool = new Pool({ connectionString: resolved.url });
    try {
      const db = drizzleNodePg({ client: pool, schema });
      await migrateNodePg(db, { migrationsFolder });
    } finally {
      await pool.end();
    }
    return;
  }

  const dataDir = resolved.dataDir;
  await mkdir(dataDir, { recursive: true });
  let client: Awaited<ReturnType<typeof PGlite.create>>;
  try {
    client = await PGlite.create(dataDir);
  } catch (error) {
    throw toPgliteStartupError(dataDir, error);
  }

  try {
    const db = drizzlePgLite({ client, schema });
    await migratePgLite(db, { migrationsFolder });
  } finally {
    await client.close();
  }
}
