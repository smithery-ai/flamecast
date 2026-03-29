#!/usr/bin/env node
/**
 * Seed the database with builtin agent templates.
 * Run via: DATABASE_URL=... npx tsx src/seed.ts
 */
import { defaultAgentTemplates } from "./default-templates.js";
import { createDatabase, migrateDatabase } from "./db.js";
import { createStorageFromDb } from "./storage.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

await migrateDatabase({ url });

const { db, close } = await createDatabase({ url });
const storage = createStorageFromDb(db);
await storage.seedAgentTemplates(defaultAgentTemplates);

console.log(`Seeded ${defaultAgentTemplates.length} templates`);
await close();
