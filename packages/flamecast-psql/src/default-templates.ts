import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTemplate } from "@flamecast/sdk";

const thisDir = dirname(fileURLToPath(import.meta.url));
const exampleAgentPath = resolve(thisDir, "../../flamecast/src/flamecast/agent.ts");

/** Builtin agent templates seeded on startup. */
export const defaultAgentTemplates: AgentTemplate[] = [
  {
    id: "example",
    name: "Example agent",
    spawn: { command: "pnpm", args: ["exec", "tsx", exampleAgentPath] },
    runtime: { provider: "default" },
  },
  {
    id: "codex",
    name: "Codex ACP",
    spawn: { command: "pnpm", args: ["dlx", "@zed-industries/codex-acp"] },
    runtime: { provider: "default" },
  },
  {
    id: "example-docker",
    name: "Example agent (Docker)",
    spawn: { command: "npx", args: ["tsx", "agent.ts"] },
    runtime: {
      provider: "docker",
      // No image/dockerfile — uses the default flamecast-session-host image.
      // Setup installs agent deps and downloads the agent script at startup.
      setup:
        "npm install tsx @agentclientprotocol/sdk && " +
        "curl -sf -o agent.ts https://raw.githubusercontent.com/smithery-ai/flamecast/main/packages/flamecast/src/flamecast/agent.ts",
    },
  },
  {
    id: "example-docker-2",
    name: "Example agent (Docker 2)",
    spawn: { command: "npx", args: ["tsx", "agent.ts"] },
    runtime: {
      provider: "docker",
      setup:
        "npm install tsx @agentclientprotocol/sdk && " +
        "curl -sf -o agent.ts https://raw.githubusercontent.com/smithery-ai/flamecast/main/packages/flamecast/src/flamecast/agent.ts",
    },
  },
];
