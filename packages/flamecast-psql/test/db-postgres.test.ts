import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const poolEnd = vi.fn(async () => {});
  const Pool = vi.fn(function PoolMock({ connectionString }: { connectionString: string }) {
    return {
      connectionString,
      end: poolEnd,
    };
  });
  const drizzleNodePg = vi.fn(() => ({ kind: "pg-db" }));
  const migrateNodePg = vi.fn(async () => {});

  return {
    poolEnd,
    Pool,
    drizzleNodePg,
    migrateNodePg,
  };
});

vi.mock("pg", () => ({ Pool: mocks.Pool }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: mocks.drizzleNodePg }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: mocks.migrateNodePg }));

import { createDatabase, migrateDatabase } from "../src/db.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("database client postgres branch", () => {
  test("uses postgres when url is provided", async () => {
    const bundle = await createDatabase({ url: "postgres://db/flamecast" });

    expect(mocks.Pool).toHaveBeenCalledWith({ connectionString: "postgres://db/flamecast" });
    expect(mocks.drizzleNodePg).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({
          connectionString: "postgres://db/flamecast",
        }),
      }),
    );
    expect(mocks.migrateNodePg).not.toHaveBeenCalled();
    expect(bundle.db).toEqual({ kind: "pg-db" });

    await bundle.close();
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
  });

  test("runs postgres migrations explicitly", async () => {
    await migrateDatabase({ url: "postgres://db/flamecast" });

    expect(mocks.Pool).toHaveBeenCalledWith({ connectionString: "postgres://db/flamecast" });
    expect(mocks.drizzleNodePg).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({
          connectionString: "postgres://db/flamecast",
        }),
      }),
    );
    expect(mocks.migrateNodePg).toHaveBeenCalledWith(
      { kind: "pg-db" },
      expect.objectContaining({
        migrationsFolder: expect.stringContaining(path.join("src", "migrations")),
      }),
    );
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
  });
});
