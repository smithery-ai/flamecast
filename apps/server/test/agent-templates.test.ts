import { describe, expect, it } from "vitest";
import { createAgentTemplates } from "../src/agent-templates.js";

describe("createAgentTemplates", () => {
  it("returns default templates", () => {
    const templates = createAgentTemplates();
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0].id).toBe("codex");
    expect(templates[0].spawn.command).toBe("codex");
  });
});
