/* v8 ignore file */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export type PsqlAppDb = PostgresJsDatabase<typeof schema>;
