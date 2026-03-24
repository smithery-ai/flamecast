/* v8 ignore file */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema.js";

export type PsqlAppDb = PostgresJsDatabase<typeof schema> | PgliteDatabase<typeof schema>;
