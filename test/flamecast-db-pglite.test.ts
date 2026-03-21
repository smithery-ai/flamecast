import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mkdir = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const createPGlite = vi
    .fn()
    .mockResolvedValueOnce({ close })
    .mockResolvedValueOnce({ close })
    .mockResolvedValueOnce({ close });
  const drizzlePgLite = vi
    .fn()
    .mockReturnValueOnce({ kind: "pglite-explicit" })
    .mockReturnValueOnce({ kind: "pglite-env" })
    .mockReturnValueOnce({ kind: "pglite-default" });
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

import { createDatabase } from "../src/flamecast/db/client.js";

afterEach(() => {
  delete process.env.FLAMECAST_POSTGRES_URL;
  delete process.env.FLAMECAST_PGLITE_DIR;
  delete process.env.ACP_PGLITE_DIR;
  vi.clearAllMocks();
});

describe("database client pglite branch", () => {
  test("falls back to pglite with explicit data dir, FLAMECAST_PGLITE_DIR, and the default cwd path", async () => {
    process.env.FLAMECAST_POSTGRES_URL = "   ";
    process.env.FLAMECAST_PGLITE_DIR = "/tmp/env-pglite";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const explicit = await createDatabase({ pgliteDataDir: "/tmp/explicit-pglite" });
    const envBundle = await createDatabase();
    delete process.env.FLAMECAST_PGLITE_DIR;
    delete process.env.ACP_PGLITE_DIR;
    const defaultBundle = await createDatabase();

    expect(mocks.createPGlite).toHaveBeenNthCalledWith(1, path.resolve("/tmp/explicit-pglite"));
    expect(mocks.createPGlite).toHaveBeenNthCalledWith(2, path.resolve("/tmp/env-pglite"));
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
    expect(explicit.db).toEqual({ kind: "pglite-explicit" });
    expect(envBundle.db).toEqual({ kind: "pglite-env" });
    expect(defaultBundle.db).toEqual({ kind: "pglite-default" });

    await explicit.close();
    await envBundle.close();
    await defaultBundle.close();
    expect(mocks.close).toHaveBeenCalledTimes(3);
  });

  test("rewrites the raw pglite abort into an actionable startup error", async () => {
    process.env.FLAMECAST_POSTGRES_URL = "";
    mocks.createPGlite.mockRejectedValueOnce(
      new Error("RuntimeError: Aborted(). Build with -sASSERTIONS for more info."),
    );

    await expect(createDatabase({ pgliteDataDir: "/tmp/locked-pglite" })).rejects.toThrow(
      /Failed to open the local PGlite database at ".*locked-pglite".*another Flamecast process is already using that directory/s,
    );
  });
});
