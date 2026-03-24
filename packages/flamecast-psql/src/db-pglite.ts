import path from "node:path";
import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.js";
import { getMigrationsFolder } from "./migrations-path.js";
import type { PsqlAppDb } from "./types.js";
import type { DatabaseBundle } from "./db.js";

/**
 * Create an embedded PGLite database on disk.
 * Node-only — uses node:fs, node:path, and PGLite WASM.
 */
export async function createPgliteDatabase(dataDir?: string): Promise<DatabaseBundle> {
  const resolvedDir = path.resolve(
    dataDir ?? process.env.FLAMECAST_PGLITE_DIR ?? path.join(process.cwd(), ".flamecast", "pglite"),
  );
  await mkdir(resolvedDir, { recursive: true });

  const client = await PGlite.create(resolvedDir);
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: getMigrationsFolder() });

  return {
    // oxlint-disable-next-line no-type-assertion/no-type-assertion -- PgliteDatabase and PostgresJsDatabase share the same query interface
    db: db as unknown as PsqlAppDb,
    close: async () => {
      await client.close();
    },
  };
}
