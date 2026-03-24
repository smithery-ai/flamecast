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
 * Connect to Postgres via postgres.js.
 * Edge-safe — no dynamic imports, no Node-only deps.
 */
export function createPostgresDatabase(url: string): DatabaseBundle {
  const client = postgres(url, {
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

/**
 * Connect to Postgres when a URL is provided; otherwise fall back to
 * embedded PGLite on disk.
 *
 * PGLite path uses dynamic imports so it's never bundled into
 * edge runtimes (Workers) that always provide a URL. If you only
 * need Postgres, use createPostgresDatabase() directly.
 */
export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<DatabaseBundle> {
  if (options.url) {
    return createPostgresDatabase(options.url);
  }

  // Lazy import — keeps PGLite out of edge bundles
  const { createPgliteDatabase } = await import("./db-pglite.js");
  return createPgliteDatabase(options.dataDir);
}
