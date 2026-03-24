import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to Drizzle migration files for the PSQL state manager. */
export function getMigrationsFolder(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
}
