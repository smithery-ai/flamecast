import type { AgentTemplate } from "@flamecast/sdk";

type CreateAgentTemplatesOptions = {
  dockerEnabled: boolean;
  agentJsEnabled: boolean;
  e2bEnabled: boolean;
  hostAgentPath: string;
  agentSource: string;
};

export function createAgentTemplates({
  dockerEnabled,
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
      name: "Dummy Agent",
      spawn: { command: "npx", args: ["tsx", hostAgentPath] },
      runtime: { provider: "local" },
    },
    {
      id: "codex",
      name: "Codex",
      spawn: { command: "npx", args: ["--yes", "@zed-industries/codex-acp"] },
      runtime: { provider: "local" },
    } satisfies AgentTemplate,
    {
      id: "claude-code",
      name: "Claude Code",
      spawn: { command: "npx", args: ["--yes", "@zed-industries/claude-agent-acp"] },
      runtime: { provider: "local" },
    } satisfies AgentTemplate,
    ...(dockerEnabled
      ? [
          {
            id: "docker-echo-agent",
            name: "Echo Agent",
            spawn: { command: "npx", args: ["tsx", "agent.ts"] },
            runtime: {
              provider: "docker",
              setup: sandboxSetup,
            },
          } satisfies AgentTemplate,
        ]
      : []),
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
