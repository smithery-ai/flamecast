import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTemplate } from "@flamecast/protocol/session";

const sdkDir = dirname(fileURLToPath(import.meta.resolve("@flamecast/sdk/package.json")));
const exampleAgentPath = resolve(sdkDir, "dist/flamecast/agent.js");

/** Builtin agent templates seeded on startup. */
export const defaultAgentTemplates: AgentTemplate[] = [
  {
    id: "example",
    name: "Example agent",
    spawn: { command: "node", args: [exampleAgentPath] },
    runtime: { provider: "default" },
  },
  {
    id: "codex",
    name: "Codex ACP",
    spawn: { command: "npx", args: ["--yes", "@zed-industries/codex-acp"] },
    runtime: { provider: "default" },
  },
  {
    id: "example-docker",
    name: "Example agent (Docker)",
    spawn: { command: "npx", args: ["tsx", "agent.ts"] },
    runtime: {
      provider: "docker",
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
