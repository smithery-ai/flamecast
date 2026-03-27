import type { AgentTemplate } from "@flamecast/sdk";

type CreateAgentTemplatesOptions = {
  agentJsEnabled: boolean;
  e2bEnabled: boolean;
  hostAgentPath: string;
  agentSource: string;
};

export function createAgentTemplates({
  agentJsEnabled,
  e2bEnabled,
  hostAgentPath,
  agentSource,
}: CreateAgentTemplatesOptions): AgentTemplate[] {
  const sandboxSetup = [
    "npm install tsx @agentclientprotocol/sdk",
    `cat > agent.ts << 'AGENT_EOF'\n${agentSource}\nAGENT_EOF`,
  ].join(" && ");

  return [
    {
      id: "echo-agent",
      name: "Echo Agent",
      spawn: { command: "npx", args: ["tsx", hostAgentPath] },
      runtime: { provider: "default" },
    },
    {
      id: "docker-echo-agent",
      name: "Echo Agent",
      spawn: { command: "npx", args: ["tsx", "agent.ts"] },
      runtime: {
        provider: "docker",
        setup: sandboxSetup,
      },
    },
    ...(e2bEnabled
      ? [
          {
            id: "e2b-echo-agent",
            name: "Echo Agent",
            spawn: { command: "npx", args: ["tsx", "agent.ts"] },
            runtime: {
              provider: "e2b",
              setup: sandboxSetup,
            },
          } satisfies AgentTemplate,
        ]
      : []),
    ...(agentJsEnabled
      ? [
          {
            id: "agentjs",
            name: "Agent.js",
            spawn: { command: "remote-sessionhost", args: ["agentjs"] },
            runtime: { provider: "agentjs" },
          } satisfies AgentTemplate,
        ]
      : []),
  ];
}
