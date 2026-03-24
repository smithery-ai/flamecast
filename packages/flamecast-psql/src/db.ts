import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PsqlAppDb } from "./types.js";
import * as schema from "./schema.js";

export type DatabaseBundle = {
  db: PsqlAppDb;
  /** Close the Postgres connection pool or PGLite instance. */
  close: () => Promise<void>;
};

export type CreateDatabaseOptions = {
  /** Postgres connection URL. If omitted, falls back to embedded PGLite. */
  url?: string;
  /** PGLite data directory (only used when no URL is provided). */
  dataDir?: string;
};

/**
 * Connect to Postgres when a URL is provided; otherwise fall back to
 * embedded PGLite on disk.
 *
 * The PGLite path uses dynamic imports so it's never bundled into
 * edge runtimes (Workers) that always provide a URL.
 */
export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<DatabaseBundle> {
  if (options.url) {
    const client = postgres(options.url, {
      prepare: false,
      max: 1,
    });
    const db = drizzle(client, { schema });
    return {
      db,
      close: async () => {
        await client.end();
      },
    };
  }

  // PGLite fallback — dynamic import so it's never bundled for edge runtimes
  const path = await import("node:path");
  const { mkdir } = await import("node:fs/promises");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePgLite } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const { getMigrationsFolder } = await import("./migrations-path.js");

  const dataDir = path.resolve(
    options.dataDir ??
      process.env.FLAMECAST_PGLITE_DIR ??
      path.join(process.cwd(), ".flamecast", "pglite"),
  );
  await mkdir(dataDir, { recursive: true });

  const client = await PGlite.create(dataDir);
  // oxlint-disable-next-line no-type-assertion/no-type-assertion -- PgliteDatabase and PostgresJsDatabase share the same query interface
  const db: PsqlAppDb = drizzlePgLite({ client, schema }) as unknown as PsqlAppDb;
  // oxlint-disable-next-line no-type-assertion/no-type-assertion, typescript-eslint/no-explicit-any -- migrate() types don't accept the union
  await migrate(db as any, { migrationsFolder: getMigrationsFolder() });

  return {
    db,
    close: async () => {
      await client.close();
    },
  };
}
