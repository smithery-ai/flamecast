import { describe, expect, it } from "vitest";
import { Flamecast } from "../../src/flamecast/index.js";
import { MemoryFlamecastStorage } from "../../src/flamecast/storage/memory/index.js";

describe("storage alignment", () => {
  it("persists registered agent templates through Flamecast storage", async () => {
    const storage = new MemoryFlamecastStorage();
    const flamecastA = new Flamecast({ storage });

    const template = await flamecastA.registerAgentTemplate({
      name: "Persistent template",
      spawn: { command: "node", args: ["agent.js"] },
    });

    const flamecastB = new Flamecast({ storage });
    const templates = await flamecastB.listAgentTemplates();

    expect(templates.find((entry) => entry.id === template.id)).toEqual(template);
    expect(templates.find((entry) => entry.id === "example")).toBeDefined();
  });
});
