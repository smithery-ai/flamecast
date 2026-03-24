import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const end = vi.fn(async () => {});
  const postgresClient = vi.fn(() => {
    const client = Object.assign(() => {}, { end });
    return client;
  });
  const drizzlePostgresJs = vi.fn(() => ({ kind: "postgres-js-db" }));

  return { end, postgresClient, drizzlePostgresJs };
});

vi.mock("postgres", () => ({ default: mocks.postgresClient }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.drizzlePostgresJs }));

import { createDatabase } from "../src/db.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("database client postgres branch", () => {
  test("connects using postgres.js when url is provided", async () => {
    const bundle = await createDatabase({ url: "postgres://db/flamecast" });

    expect(mocks.postgresClient).toHaveBeenCalledWith("postgres://db/flamecast", {
      prepare: false,
      max: 1,
    });
    expect(mocks.drizzlePostgresJs).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        schema: expect.any(Object),
      }),
    );
    expect(bundle.db).toEqual({ kind: "postgres-js-db" });

    await bundle.close();
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
});
