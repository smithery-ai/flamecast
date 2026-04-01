import type { AgentTemplate } from "@flamecast/sdk";

/**
 * Default agent templates. These are in-memory config — no database needed.
 */
export function createAgentTemplates(): AgentTemplate[] {
  return [
    {
      id: "codex",
      name: "Codex",
      spawn: { command: "codex", args: [] },
      runtime: { provider: "default" },
    },
  ];
}
