import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mkdir = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const createPGlite = vi.fn();
  const drizzlePgLite = vi.fn();
  const migratePgLite = vi.fn(async () => {});

  return {
    mkdir,
    close,
    createPGlite,
    drizzlePgLite,
    migratePgLite,
  };
});

vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir }));
vi.mock("@electric-sql/pglite", () => ({
  PGlite: { create: mocks.createPGlite },
}));
vi.mock("drizzle-orm/pglite", () => ({ drizzle: mocks.drizzlePgLite }));
vi.mock("drizzle-orm/pglite/migrator", () => ({ migrate: mocks.migratePgLite }));

import { createDatabase } from "../src/storage/db/client.js";

function resetPgliteMocks() {
  mocks.mkdir.mockReset().mockImplementation(async () => {});
  mocks.close.mockReset().mockImplementation(async () => {});
  mocks.createPGlite.mockReset().mockImplementation(async () => ({ close: mocks.close }));
  mocks.drizzlePgLite.mockReset().mockImplementation(() => ({ kind: "pglite" }));
  mocks.migratePgLite.mockReset().mockImplementation(async () => {});
}

resetPgliteMocks();

afterEach(() => {
  delete process.env.FLAMECAST_POSTGRES_URL;
  delete process.env.FLAMECAST_PGLITE_DIR;
  resetPgliteMocks();
  vi.restoreAllMocks();
});

describe("database client pglite branch", () => {
  test("falls back to pglite with explicit data dir, FLAMECAST_PGLITE_DIR, and the default cwd path", async () => {
    process.env.FLAMECAST_POSTGRES_URL = "   ";
    process.env.FLAMECAST_PGLITE_DIR = "/tmp/flamecast-env-pglite";
    process.env.ACP_PGLITE_DIR = "/tmp/ignored-acp-env-pglite";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const explicit = await createDatabase({ pgliteDataDir: "/tmp/explicit-pglite" });
    const flamecastEnvBundle = await createDatabase();
    delete process.env.FLAMECAST_PGLITE_DIR;
    const defaultBundle = await createDatabase();

    expect(mocks.createPGlite).toHaveBeenNthCalledWith(1, path.resolve("/tmp/explicit-pglite"));
    expect(mocks.createPGlite).toHaveBeenNthCalledWith(
      2,
      path.resolve("/tmp/flamecast-env-pglite"),
    );
    expect(mocks.createPGlite).toHaveBeenNthCalledWith(
      3,
      path.resolve(path.join(process.cwd(), ".flamecast", "pglite")),
    );
    expect(mocks.mkdir).toHaveBeenCalledTimes(3);
    expect(mocks.migratePgLite).toHaveBeenCalledTimes(3);
    expect(mocks.drizzlePgLite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        client: expect.any(Object),
      }),
    );
    expect(warn).toHaveBeenCalledTimes(3);
    expect(explicit.db).toEqual({ kind: "pglite" });
    expect(flamecastEnvBundle.db).toEqual({ kind: "pglite" });
    expect(defaultBundle.db).toEqual({ kind: "pglite" });

    await explicit.close();
    await flamecastEnvBundle.close();
    await defaultBundle.close();
    expect(mocks.close).toHaveBeenCalledTimes(3);
  });

  test("rewrites locked-directory startup failures to a friendlier message", async () => {
    process.env.FLAMECAST_POSTGRES_URL = "   ";
    mocks.createPGlite.mockRejectedValueOnce(new Error("sqlite backend: Aborted()"));
    const startup = createDatabase({ pgliteDataDir: "/tmp/locked-pglite" });

    await expect(startup).rejects.toThrow(
      'Failed to open the local PGlite database at "/tmp/locked-pglite".',
    );
    await expect(startup).rejects.toThrow(/FLAMECAST_PGLITE_DIR/);
  });

  test("preserves non-lock startup Error values", async () => {
    process.env.FLAMECAST_POSTGRES_URL = "   ";
    const failure = new Error("disk offline");
    mocks.createPGlite.mockRejectedValueOnce(failure);

    await expect(createDatabase({ pgliteDataDir: "/tmp/broken-pglite" })).rejects.toBe(failure);
  });

  test("wraps non-Error startup failures", async () => {
    process.env.FLAMECAST_POSTGRES_URL = "   ";
    mocks.createPGlite.mockRejectedValueOnce("boom");

    await expect(createDatabase({ pgliteDataDir: "/tmp/broken-pglite" })).rejects.toThrow("boom");
  });
});
