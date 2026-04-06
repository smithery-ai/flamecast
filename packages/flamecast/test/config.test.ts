import { describe, expect, it } from "vitest";
import { Flamecast } from "../src/index.js";
import { createTestStorage } from "./fixtures/storage.js";
import type { Runtime } from "@flamecast/protocol/runtime";

function createRuntime(): Runtime {
  return {
    async fetchSession() {
      return new Response(null, { status: 200 });
    },
  };
}

describe("flamecast backend init", () => {
  it("initializes storage and delegates migration helpers through the backend", async () => {
    const storage = await createTestStorage();
    const migrationStatus = {
      pending: [],
      current: null,
      isUpToDate: true,
    };
    const backend = {
      createStorage: async () => storage,
      getMigrationStatus: async () => migrationStatus,
      migrate: async () => ({
        applied: [],
        status: migrationStatus,
      }),
      getStudioConfig: async () => ({ dialect: "postgresql" }),
    };

    const flamecast = new Flamecast({
      backend,
      runtimes: {
        default: createRuntime(),
      },
    });

    await flamecast.init();

    await expect(flamecast.listAgentTemplates()).resolves.toEqual([]);
    await expect(flamecast.getMigrationStatus()).resolves.toEqual(migrationStatus);
    await expect(flamecast.migrate()).resolves.toEqual({
      applied: [],
      status: migrationStatus,
    });
    await expect(flamecast.getStudioConfig()).resolves.toEqual({ dialect: "postgresql" });
  });
});
