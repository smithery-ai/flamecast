import { defineConfig } from "drizzle-kit";

/** Paths are relative to the repo root (where `bun run psql:generate` runs). */
export default defineConfig({
  schema: "./src/flamecast/state-managers/psql/schema.ts",
  out: "./src/flamecast/state-managers/psql/migrations",
  dialect: "postgresql",
});
