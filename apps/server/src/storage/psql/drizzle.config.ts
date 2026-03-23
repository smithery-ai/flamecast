/* v8 ignore file */
import { defineConfig } from "drizzle-kit";

/** Paths are relative to the repo root (where `pnpm psql:generate` runs). */
export default defineConfig({
  schema: "./apps/server/src/storage/psql/schema.ts",
  out: "./apps/server/src/storage/psql/migrations",
  dialect: "postgresql",
});
