import type { AgentTemplate } from "@flamecast/protocol/session";

/** Builtin agent templates seeded on startup. */
export const defaultAgentTemplates: AgentTemplate[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    spawn: {
      command: "npx",
      args: ["-y", "@zed-industries/claude-agent-acp"],
    },
    runtime: { provider: "default" },
  },
  {
    id: "codex",
    name: "Codex",
    spawn: {
      command: "npx",
      args: ["-y", "@zed-industries/codex-acp"],
    },
    runtime: { provider: "default" },
  },
];
