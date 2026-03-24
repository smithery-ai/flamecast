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
    runtime: {
      provider: "container",
      setup:
        "mkdir -p packages/flamecast/src/flamecast && npm install tsx @agentclientprotocol/sdk && curl -sf -o packages/flamecast/src/flamecast/agent.ts https://raw.githubusercontent.com/smithery-ai/flamecast/main/packages/flamecast/src/flamecast/agent.ts",
    },
  },
  {
    id: "codex",
    name: "Codex ACP",
    spawn: { command: "codex-acp", args: [] },
    runtime: {
      provider: "container",
      setup:
        "apt-get update -qq && apt-get install -y -qq libssl3 >/dev/null && npm install -g @zed-industries/codex-acp",
    },
  },
]);

console.log("Templates seeded");
await close();
