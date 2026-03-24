#!/usr/bin/env node
/**
 * Seed the database with builtin agent templates.
 * Run via: DATABASE_URL=... npx tsx src/seed.ts
 *
 * Set SEED_LOCAL=true to only include templates that work without setup
 * (i.e. agents available on the host machine).
 */
import { createDatabase } from "./db.js";
import { createStorageFromDb } from "./storage.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const isLocal = process.env.SEED_LOCAL === "true";

const allTemplates = [
  {
    id: "example",
    name: "Example agent",
    spawn: { command: "npx", args: ["tsx", "packages/flamecast/src/flamecast/agent.ts"] },
    runtime: {
      provider: "container",
      setup:
        "mkdir -p packages/flamecast/src/flamecast && npm install tsx @agentclientprotocol/sdk && curl -sf -o packages/flamecast/src/flamecast/agent.ts https://raw.githubusercontent.com/smithery-ai/flamecast/main/packages/flamecast/src/flamecast/agent.ts",
    },
    local: true,
  },
  {
    id: "codex",
    name: "Codex ACP",
    spawn: { command: "npx", args: ["@zed-industries/codex-acp"] },
    runtime: {
      provider: "container",
      setup:
        "apt-get update -qq && apt-get install -y -qq libssl3 >/dev/null && npm install -g @zed-industries/codex-acp",
    },
    local: true,
  },
];

const templates = allTemplates
  .filter((t) => !isLocal || t.local)
  .map(({ local: _, ...t }) => t);

const { db, close } = await createDatabase({ url });
const storage = createStorageFromDb(db);
await storage.seedAgentTemplates(templates);

console.log(`Templates seeded (${templates.length} templates, ${isLocal ? "local" : "deployed"})`);
await close();
