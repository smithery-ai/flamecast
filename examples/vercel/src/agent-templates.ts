import type { AgentTemplate } from "@flamecast/sdk";

type CreateAgentTemplatesOptions = {
  agentSource: string;
};

export function createAgentTemplates({
  agentSource,
}: CreateAgentTemplatesOptions): AgentTemplate[] {
  const sandboxSetup = [
    "npm install tsx @agentclientprotocol/sdk",
    `cat > agent.ts << 'AGENT_EOF'\n${agentSource}\nAGENT_EOF`,
  ].join(" && ");

  return [
    {
      id: "e2b-echo-agent",
      name: "Echo Agent",
      spawn: { command: "npx", args: ["tsx", "agent.ts"] },
      runtime: {
        provider: "e2b",
        setup: sandboxSetup,
      },
    } satisfies AgentTemplate,
  ];
}
