import { getTableConfig } from "drizzle-orm/pg-core";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { PSQL_MIGRATIONS_FOLDER } from "../src/storage/psql/migrations-path.js";
import drizzleConfig from "../src/storage/psql/drizzle.config.js";
import { agentTemplates, sessionLogs, sessions } from "../src/storage/psql/schema.js";

describe("psql module metadata", () => {
  test("exports schema and drizzle metadata", async () => {
    const psqlTypes = await import("../src/storage/psql/types.js");
    const [sessionLogForeignKey] = getTableConfig(sessionLogs).foreignKeys;

    expect(sessions).toBeDefined();
    expect(sessionLogs).toBeDefined();
    expect(agentTemplates).toBeDefined();
    expect(getTableConfig(sessionLogs).foreignKeys).toHaveLength(1);
    expect(sessionLogForeignKey?.reference().foreignTable).toBe(sessions);
    expect(getTableConfig(agentTemplates).indexes).toHaveLength(1);
    expect(path.basename(PSQL_MIGRATIONS_FOLDER)).toBe("migrations");
    expect(drizzleConfig).toMatchObject({
      schema: "./apps/server/src/storage/psql/schema.ts",
      out: "./apps/server/src/storage/psql/migrations",
      dialect: "postgresql",
    });
    expect(psqlTypes).toBeTypeOf("object");
  });
});
