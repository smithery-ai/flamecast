import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PsqlAppDb } from "./types.js";
import * as schema from "./schema.js";

export type DatabaseBundle = {
  db: PsqlAppDb;
  /** Close the Postgres connection. */
  close: () => Promise<void>;
};

/**
 * Connect to Postgres via a connection URL.
 *
 * Uses postgres.js (Workers-compatible) instead of pg (Node TCP sockets).
 * Does NOT run migrations — migrations are handled at deploy time by the
 * FlamecastDatabase Alchemy resource (via Exec), not at Worker startup.
 */
export async function createDatabase(options: { url: string }): Promise<DatabaseBundle> {
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
