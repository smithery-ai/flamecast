/* v8 ignore file */
import { defineConfig } from "drizzle-kit";

/** Paths are relative to the package root (where `pnpm psql:generate` runs). */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
