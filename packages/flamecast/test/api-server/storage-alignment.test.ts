import { describe, expect, it } from "vitest";
import { Flamecast } from "../../src/flamecast/index.js";
import type { Runtime } from "@flamecast/protocol/runtime";
import { createTestStorage } from "../fixtures/test-helpers.js";

const noopRuntime: Runtime = {
  async fetchSession() {
    return new Response("not implemented", { status: 501 });
  },
};

describe("storage alignment", () => {
  it("persists registered agent templates through Flamecast storage", async () => {
    const storage = await createTestStorage();
    const flamecastA = new Flamecast({ storage, runtimes: { local: noopRuntime } });

    const template = await flamecastA.registerAgentTemplate({
      name: "Persistent template",
      spawn: { command: "node", args: ["agent.js"] },
    });

    const flamecastB = new Flamecast({ storage, runtimes: { local: noopRuntime } });
    const templates = await flamecastB.listAgentTemplates();

    expect(templates.find((entry) => entry.id === template.id)).toEqual(template);
  });
});
