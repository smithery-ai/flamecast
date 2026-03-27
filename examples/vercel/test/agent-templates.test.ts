import { describe, expect, it } from "vitest";
import { createAgentTemplates } from "../src/agent-templates.js";

describe("createAgentTemplates", () => {
  it("only exposes the E2B echo agent and preserves the sandbox setup flow", () => {
    const templates = createAgentTemplates({ agentSource: "console.log('echo')" });

    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      id: "e2b-echo-agent",
      name: "Echo Agent",
      spawn: { command: "npx", args: ["tsx", "agent.ts"] },
      runtime: { provider: "e2b" },
    });
    expect(templates[0]?.runtime.setup).toContain("npm install tsx @agentclientprotocol/sdk");
    expect(templates[0]?.runtime.setup).toContain("cat > agent.ts");
  });
});
