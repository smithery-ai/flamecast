import { afterEach, describe, expect, test, vi } from "vitest";

function createStorageStub(label: string) {
  return {
    label,
    seedAgentTemplates: vi.fn(async () => {}),
    listAgentTemplates: vi.fn(async () => []),
    getAgentTemplate: vi.fn(async () => null),
    saveAgentTemplate: vi.fn(async () => {}),
    createSession: vi.fn(async () => {}),
    updateSession: vi.fn(async () => {}),
    appendLog: vi.fn(async () => {}),
    getSessionMeta: vi.fn(async () => null),
    getLogs: vi.fn(async () => []),
    listAllSessions: vi.fn(async () => []),
    finalizeSession: vi.fn(async () => {}),
  };
}

afterEach(() => {
  delete process.env.FLAMECAST_POSTGRES_URL;
  delete process.env.FLAMECAST_PGLITE_DIR;
  vi.restoreAllMocks();
  vi.doUnmock("../src/storage/db/client.js");
  vi.doUnmock("../src/storage/psql/index.js");
  vi.resetModules();
});

describe("server storage resolution", () => {
  test("resolves pglite, postgres, and direct storage configs", async () => {
    vi.resetModules();

    const createDatabase = vi.fn(async (options?: { pgliteDataDir?: string }) => ({
      db: { options },
      close: async () => {},
    }));
    const createPsqlStorage = vi.fn((db: unknown) => ({ kind: "psql", db }));

    vi.doMock("../src/storage/db/client.js", () => ({ createDatabase }));
    vi.doMock("../src/storage/psql/index.js", () => ({ createPsqlStorage }));

    const { createServerStorage } = await import("../src/storage/index.js");
    const directStorage = createStorageStub("direct");

    expect(await createServerStorage()).toMatchObject({ kind: "psql" });
    expect(await createServerStorage("pglite")).toMatchObject({ kind: "psql" });
    expect(
      await createServerStorage({
        type: "pglite",
        dataDir: "/tmp/flamecast-pglite",
      }),
    ).toMatchObject({ kind: "psql" });
    expect(
      await createServerStorage({
        type: "postgres",
        url: "postgres://db/flamecast",
      }),
    ).toMatchObject({ kind: "psql" });
    expect(await createServerStorage(directStorage)).toBe(directStorage);

    expect(createDatabase).toHaveBeenNthCalledWith(1);
    expect(createDatabase).toHaveBeenNthCalledWith(2);
    expect(createDatabase).toHaveBeenNthCalledWith(3, {
      pgliteDataDir: "/tmp/flamecast-pglite",
    });
    expect(createDatabase).toHaveBeenNthCalledWith(4);
    expect(createPsqlStorage).toHaveBeenCalledTimes(4);
    expect(process.env.FLAMECAST_POSTGRES_URL).toBe("postgres://db/flamecast");
  });
});
