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

const templates = [
  {
    id: "example",
    name: "Example agent",
    spawn: { command: "pnpm", args: ["exec", "tsx", "packages/flamecast/src/flamecast/agent.ts"] },
    runtime: { provider: "default" },
  },
  {
    id: "codex",
    name: "Codex ACP",
    spawn: { command: "pnpm", args: ["dlx", "@zed-industries/codex-acp"] },
    runtime: { provider: "default" },
  },
];

const { db, close } = await createDatabase({ url });
const storage = createStorageFromDb(db);
await storage.seedAgentTemplates(templates);

console.log(`Seeded ${templates.length} templates`);
await close();
