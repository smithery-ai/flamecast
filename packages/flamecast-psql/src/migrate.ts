#!/usr/bin/env node
/**
 * Run Drizzle migrations using postgres.js (same driver as the Worker).
 *
 * Replaces `drizzle-kit migrate` which uses the `pg` driver internally —
 * `pg` fails auth against pglite-server in local dev.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getMigrationsFolder } from "./migrations-path.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = postgres(url, { prepare: false, max: 1 });
const db = drizzle(client);
await migrate(db, { migrationsFolder: getMigrationsFolder() });
await client.end();
console.log("Migrations applied");
