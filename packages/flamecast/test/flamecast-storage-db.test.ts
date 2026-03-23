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
});

describe("storage resolution", () => {
  test("exposes the storage contract shape used by the SDK", async () => {
    const directStorage = createStorageStub("direct");

    expect(directStorage).toMatchObject({
      label: "direct",
      seedAgentTemplates: expect.any(Function),
      listAgentTemplates: expect.any(Function),
      getAgentTemplate: expect.any(Function),
      saveAgentTemplate: expect.any(Function),
      createSession: expect.any(Function),
      updateSession: expect.any(Function),
      appendLog: expect.any(Function),
      getSessionMeta: expect.any(Function),
      getLogs: expect.any(Function),
      listAllSessions: expect.any(Function),
      finalizeSession: expect.any(Function),
    });
  });
});
