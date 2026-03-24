import { fileURLToPath } from "node:url";
import type { AgentTemplate, AgentTemplateRuntime } from "../shared/session.js";

const pnpmCmd = () =>
  typeof process !== "undefined" && process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const exampleAgentEntrypoint = fileURLToPath(new URL("./agent.ts", import.meta.url));
const exampleAgentDockerfile = fileURLToPath(
  new URL("../../docker/example-agent.Dockerfile", import.meta.url),
);

export function localRuntime(): AgentTemplateRuntime {
  return { provider: "local" };
}

export function getBuiltinAgentTemplates(): AgentTemplate[] {
  const cmd = pnpmCmd();
  return [
    {
      id: "example",
      name: "Example agent",
      spawn: { command: cmd, args: ["exec", "tsx", exampleAgentEntrypoint] },
      runtime: localRuntime(),
    },
    {
      id: "codex",
      name: "Codex ACP",
      spawn: { command: cmd, args: ["dlx", "@zed-industries/codex-acp"] },
      runtime: localRuntime(),
    },
    {
      id: "example-docker",
      name: "Example agent (Uses stock docker containers)",
      spawn: { command: "pnpm", args: ["exec", "tsx", "agent.ts"] },
      runtime: {
        provider: "docker", // https://alchemy.run/providers/docker/container/
        image: "flamecast/example-agent",
        dockerfile: exampleAgentDockerfile,
      },
    },
    {
      id: "example-docker-2",
      name: "Example agent (Docker 2)",
      spawn: { command: "pnpm", args: ["exec", "tsx", "agent.ts"] },
      runtime: {
        provider: "docker",
        image: "flamecast/example-agent",
        dockerfile: exampleAgentDockerfile,
      },
    },
  ];
}
