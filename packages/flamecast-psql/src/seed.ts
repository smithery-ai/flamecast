#!/usr/bin/env node
/**
 * Seed the database with builtin agent templates.
 * Run via: DATABASE_URL=... npx tsx src/seed.ts
 */
import { createDatabase } from "./db.js";
import { createStorageFromDb } from "./storage.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { db, close } = await createDatabase({ url });
const storage = createStorageFromDb(db);

await storage.seedAgentTemplates([
  {
    id: "example",
    name: "Example agent",
    spawn: { command: "npx", args: ["tsx", "packages/flamecast/src/flamecast/agent.ts"] },
    runtime: { provider: "container" },
  },
  {
    id: "codex",
    name: "Codex ACP",
    spawn: { command: "npx", args: ["@zed-industries/codex-acp"] },
    runtime: { provider: "container" },
  },
]);

console.log("Templates seeded");
await close();
