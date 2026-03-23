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

import { createDatabase } from "../src/storage/db/client.js";

afterEach(() => {
  delete process.env.FLAMECAST_POSTGRES_URL;
  vi.clearAllMocks();
});

describe("database client postgres branch", () => {
  test("uses postgres when FLAMECAST_POSTGRES_URL is set", async () => {
    process.env.FLAMECAST_POSTGRES_URL = "  postgres://db/flamecast  ";

    const bundle = await createDatabase();

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
        migrationsFolder: expect.stringContaining(
          path.join("apps", "server", "src", "storage", "psql", "migrations"),
        ),
      }),
    );
    expect(bundle.db).toEqual({ kind: "pg-db" });

    await bundle.close();
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
  });
});
