import path from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import { PSQL_MIGRATIONS_FOLDER } from "../src/migrations-path.js";
import drizzleConfig from "../src/drizzle.config.js";
import { agentTemplates, sessions } from "../src/schema.js";

describe("psql module metadata", () => {
  test("exports schema and drizzle metadata", async () => {
    const psqlTypes = await import("../src/types.js");

    expect(sessions).toBeDefined();
    expect(agentTemplates).toBeDefined();
    expect(getTableConfig(agentTemplates).indexes).toHaveLength(1);
    expect(path.basename(PSQL_MIGRATIONS_FOLDER)).toBe("migrations");
    expect(drizzleConfig).toMatchObject({
      schema: "./src/schema.ts",
      out: "./src/migrations",
      dialect: "postgresql",
    });
    expect(psqlTypes).toBeTypeOf("object");
  });
});
