import { describe, expect, it } from "vitest";
import { createAgentTemplates } from "../src/agent-templates.js";

describe("createAgentTemplates", () => {
  it("uses a setup-driven docker template with a container-local workspace", () => {
    const templates = createAgentTemplates({
      agentJsEnabled: false,
      e2bEnabled: false,
      hostAgentPath: "/host/agent.ts",
      agentSource: "console.log('unused')",
    });

    const dockerTemplate = templates.find((template) => template.id === "docker-echo-agent");

    expect(dockerTemplate).toBeDefined();
    expect(dockerTemplate?.spawn).toEqual({ command: "npx", args: ["tsx", "agent.ts"] });
    expect(dockerTemplate?.runtime.provider).toBe("docker");
    expect(dockerTemplate?.runtime.setup).toContain("npm install tsx @agentclientprotocol/sdk");
    expect(dockerTemplate?.runtime.setup).toContain("cat > agent.ts");
  });

  it("keeps the e2b setup flow because the sandbox does not mount the repo", () => {
    const templates = createAgentTemplates({
      agentJsEnabled: false,
      e2bEnabled: true,
      hostAgentPath: "/host/agent.ts",
      agentSource: "console.log('echo')",
    });

    const e2bTemplate = templates.find((template) => template.id === "e2b-echo-agent");

    expect(e2bTemplate).toBeDefined();
    expect(e2bTemplate?.spawn).toEqual({ command: "npx", args: ["tsx", "agent.ts"] });
    expect(e2bTemplate?.runtime.provider).toBe("e2b");
    expect(e2bTemplate?.runtime.setup).toContain("npm install tsx @agentclientprotocol/sdk");
    expect(e2bTemplate?.runtime.setup).toContain("cat > agent.ts");
  });
});
