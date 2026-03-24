import { describe, expect, it } from "vitest";
import { Flamecast, type RuntimeClient } from "../../src/flamecast/index.js";
import { MemoryFlamecastStorage } from "../../src/flamecast/storage/memory/index.js";

const noopClient: RuntimeClient = {
  async startSession() {
    throw new Error("not implemented");
  },
  async terminateSession() {},
  hasSession() {
    return false;
  },
  listSessionIds() {
    return [];
  },
};

describe("storage alignment", () => {
  it("persists registered agent templates through Flamecast storage", async () => {
    const storage = new MemoryFlamecastStorage();
    const flamecastA = new Flamecast({ storage, runtimeClient: noopClient });

    const template = await flamecastA.registerAgentTemplate({
      name: "Persistent template",
      spawn: { command: "node", args: ["agent.js"] },
    });

    const flamecastB = new Flamecast({ storage, runtimeClient: noopClient });
    const templates = await flamecastB.listAgentTemplates();

    expect(templates.find((entry) => entry.id === template.id)).toEqual(template);
  });
});
