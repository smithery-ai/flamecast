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
  vi.restoreAllMocks();
  vi.doUnmock("../src/flamecast/storage/memory/index.js");
  vi.resetModules();
});

describe("storage resolution", () => {
  test("resolves memory and direct storage configs", async () => {
    vi.resetModules();

    const memoryInstances: Array<{ label: string }> = [];
    const MemoryFlamecastStorage = vi.fn(function MemoryFlamecastStorageMock() {
      const storage = createStorageStub(`memory-${memoryInstances.length + 1}`);
      memoryInstances.push(storage);
      return storage;
    });

    vi.doMock("../src/flamecast/storage/memory/index.js", () => ({
      MemoryFlamecastStorage,
    }));

    const { resolveStorage } = await import("../src/flamecast/storage.js");
    const directStorage = createStorageStub("direct");

    expect(await resolveStorage()).toMatchObject({ label: "memory-1" });
    expect(await resolveStorage("memory")).toMatchObject({ label: "memory-2" });
    expect(await resolveStorage({ type: "memory" })).toMatchObject({ label: "memory-3" });
    expect(await resolveStorage(directStorage)).toBe(directStorage);

    expect(MemoryFlamecastStorage).toHaveBeenCalledTimes(3);
  });
});
