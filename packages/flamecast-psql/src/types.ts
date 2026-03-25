/* v8 ignore file */
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type PsqlAppDb = PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;
