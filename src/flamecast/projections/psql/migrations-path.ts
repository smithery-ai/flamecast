import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to Drizzle migration files for the PSQL projection. */
export const PSQL_MIGRATIONS_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);
