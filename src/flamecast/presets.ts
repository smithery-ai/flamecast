const npxCmd = () => (typeof process !== "undefined" && process.platform === "win32" ? "npx.cmd" : "npx");

export type AgentPreset = {
  id: string;
  label: string;
  spawn: { command: string; args: string[] };
};

export function getBuiltinAgentPresets(): AgentPreset[] {
  const cmd = npxCmd();
  return [
    {
      id: "example",
      label: "Example agent",
      spawn: { command: cmd, args: ["tsx", "src/flamecast/agent.ts"] },
    },
    {
      id: "codex",
      label: "Codex ACP",
      spawn: { command: cmd, args: ["@zed-industries/codex-acp"] },
    },
    {
      id: "example-docker",
      label: "Example agent (Docker)",
      spawn: { command: "docker:agent.ts", args: [] },
    },
  ];
}
