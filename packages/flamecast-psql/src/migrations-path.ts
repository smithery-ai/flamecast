import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(modulePath);
const moduleExt = path.extname(modulePath);
const siblingExt = moduleExt === ".ts" ? ".ts" : ".js";

/** Absolute path to Drizzle migration files for the PSQL state manager. */
export const PSQL_MIGRATIONS_FOLDER = path.join(moduleDir, "migrations");

/** Absolute path to the Drizzle schema module for the PSQL state manager. */
export const PSQL_SCHEMA_FILE = path.join(moduleDir, `schema${siblingExt}`);
