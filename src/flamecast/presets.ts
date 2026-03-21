const npxCmd = () =>
  typeof process !== "undefined" && process.platform === "win32" ? "npx.cmd" : "npx";

/**
 * Agent runtime — maps to alchemy/{type} provider.
 * "local" = ChildProcess (no alchemy).
 * Any other type = alchemy resource (e.g. "docker" → alchemy/docker).
 */
export type AgentRuntime = {
  type: string;
  image?: string;
  dockerfile?: string;
};

export type AgentPreset = {
  id: string;
  label: string;
  spawn: { command: string; args: string[] };
  runtime: AgentRuntime;
};

export function getBuiltinAgentPresets(): AgentPreset[] {
  const cmd = npxCmd();
  return [
    {
      id: "example",
      label: "Example agent",
      spawn: { command: cmd, args: ["tsx", "src/flamecast/agent.ts"] },
      runtime: { type: "local" },
    },
    {
      id: "codex",
      label: "Codex ACP",
      spawn: { command: cmd, args: ["@zed-industries/codex-acp"] },
      runtime: { type: "local" },
    },
    {
      id: "example-docker",
      label: "Example agent (Uses stock docker containers)",
      spawn: { command: "npx", args: ["tsx", "agent.ts"] },
      runtime: {
        type: "docker", // https://alchemy.run/providers/docker/container/
        image: "flamecast/example-agent",
        dockerfile: "docker/example-agent.Dockerfile",
      },
    },
    {
      id: "example-docker-2",
      label: "Example agent (Docker 2)",
      spawn: { command: "npx", args: ["tsx", "agent.ts"] },
      runtime: {
        type: "docker",
        image: "flamecast/example-agent",
        dockerfile: "docker/example-agent.Dockerfile",
      },
    },
  ];
}
