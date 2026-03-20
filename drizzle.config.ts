import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/flamecast/projections/psql/schema.ts",
  out: "./src/flamecast/projections/psql/migrations",
  dialect: "postgresql",
});
