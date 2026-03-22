import { afterEach, describe, expect, test, vi } from "vitest";

function createStorageStub(label: string) {
  return {
    label,
    listAgents: vi.fn(async () => []),
    getAgent: vi.fn(async () => null),
    createAgent: vi.fn(async () => {}),
    updateAgent: vi.fn(async () => {}),
    seedAgentTemplates: vi.fn(async () => {}),
    listAgentTemplates: vi.fn(async () => []),
    getAgentTemplate: vi.fn(async () => null),
    saveAgentTemplate: vi.fn(async () => {}),
    createSession: vi.fn(async () => {}),
    listSessionsByAgent: vi.fn(async () => []),
    updateSession: vi.fn(async () => {}),
    appendLog: vi.fn(async () => {}),
    getSessionMeta: vi.fn(async () => null),
    getLogs: vi.fn(async () => []),
    finalizeSession: vi.fn(async () => {}),
    finalizeAgent: vi.fn(async () => {}),
  };
}

afterEach(() => {
  delete process.env.FLAMECAST_POSTGRES_URL;
  delete process.env.ACP_PGLITE_DIR;
  vi.restoreAllMocks();
  vi.doUnmock("../src/flamecast/db/client.js");
  vi.doUnmock("../src/flamecast/state-managers/psql/index.js");
  vi.doUnmock("../src/flamecast/state-managers/memory/index.js");
  vi.resetModules();
});

describe("storage resolution", () => {
  test("resolves memory, pglite, postgres, and direct storage configs", async () => {
    vi.resetModules();

    const memoryInstances: Array<{ label: string }> = [];
    const createDatabase = vi.fn(async (options?: { pgliteDataDir?: string }) => ({
      db: { options },
      close: async () => {},
    }));
    const createPsqlStorage = vi.fn((db: unknown) => ({ kind: "psql", db }));
    const MemoryFlamecastStorage = vi.fn(function MemoryFlamecastStorageMock() {
      const storage = createStorageStub(`memory-${memoryInstances.length + 1}`);
      memoryInstances.push(storage);
      return storage;
    });

    vi.doMock("../src/flamecast/db/client.js", () => ({ createDatabase }));
    vi.doMock("../src/flamecast/state-managers/psql/index.js", () => ({ createPsqlStorage }));
    vi.doMock("../src/flamecast/state-managers/memory/index.js", () => ({
      MemoryFlamecastStorage,
    }));

    const { resolveStorage } = await import("../src/flamecast/storage.js");
    const directStorage = createStorageStub("direct");

    expect(await resolveStorage()).toMatchObject({ kind: "psql" });
    expect(await resolveStorage("pglite")).toMatchObject({ kind: "psql" });
    expect(await resolveStorage("memory")).toMatchObject({ label: "memory-1" });
    expect(await resolveStorage({ type: "memory" })).toMatchObject({ label: "memory-2" });
    expect(
      await resolveStorage({
        type: "pglite",
        dataDir: "/tmp/flamecast-pglite",
      }),
    ).toMatchObject({ kind: "psql" });
    expect(
      await resolveStorage({
        type: "postgres",
        url: "postgres://db/flamecast",
      }),
    ).toMatchObject({ kind: "psql" });
    expect(await resolveStorage(directStorage)).toBe(directStorage);

    expect(createDatabase).toHaveBeenNthCalledWith(1);
    expect(createDatabase).toHaveBeenNthCalledWith(2);
    expect(createDatabase).toHaveBeenNthCalledWith(3, {
      pgliteDataDir: "/tmp/flamecast-pglite",
    });
    expect(createDatabase).toHaveBeenNthCalledWith(4);
    expect(createPsqlStorage).toHaveBeenCalledTimes(4);
    expect(MemoryFlamecastStorage).toHaveBeenCalledTimes(2);
    expect(process.env.FLAMECAST_POSTGRES_URL).toBe("postgres://db/flamecast");
  });
});
