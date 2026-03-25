import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { DockerRuntime } from "@flamecast/runtime-docker";
import { E2BRuntime } from "@flamecast/runtime-e2b";
import { createPsqlStorage } from "@flamecast/storage-psql";
import type { Runtime } from "@flamecast/sdk/runtime";
import type { AgentTemplate } from "@flamecast/sdk";
import dotenv from "dotenv";
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(__dirname, "../agent.ts"), "utf8");

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

// Build runtimes — E2B is only available when E2B_API_KEY is set
const runtimes: Record<string, Runtime> = {
  default: new NodeRuntime(),
  // Base image defaults to "node:22-slim". Override with:
  //   new DockerRuntime({ baseImage: "node:20-slim" })
  docker: new DockerRuntime(),
};

const agentSetup = [
  "npm install tsx @agentclientprotocol/sdk",
  `cat > /workspace/agent.ts << 'AGENT_EOF'\n${agentSource}\nAGENT_EOF`,
].join(" && ");

const agentTemplates: AgentTemplate[] = [
  {
    id: "echo-agent",
    name: "Echo Agent",
    spawn: { command: "npx", args: ["tsx", resolve(__dirname, "../agent.ts")] },
    runtime: { provider: "default" },
  },
  {
    id: "docker-agent",
    name: "Docker Agent",
    setup: agentSetup,
    spawn: { command: "npx", args: ["tsx", "agent.ts"] },
    runtime: { provider: "docker" },
  },
];

const e2bApiKey = process.env.E2B_API_KEY;
if (e2bApiKey) {
  // E2B base image defaults to "node:22-slim". Override with:
  //   new E2BRuntime({ apiKey, baseImage: "node:20-slim" })
  runtimes.e2b = new E2BRuntime({ apiKey: e2bApiKey });
  agentTemplates.push({
    id: "e2b-agent",
    name: "E2B Agent",
    setup: agentSetup,
    spawn: { command: "npx", args: ["tsx", "agent.ts"] },
    runtime: { provider: "e2b" },
  });
}
else {
  console.warn("E2B_API_KEY is not set, skipping E2B runtime");
}

const flamecast = new Flamecast({
  storage: await createPsqlStorage(url ? { url } : undefined),
  runtimes,
  agentTemplates,
});

serve({ fetch: flamecast.app.fetch, port: 3001 }, (info) => {
  console.log(`Flamecast running on http://localhost:${info.port}`);
});

process.on("SIGINT", () => {
  flamecast.shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  flamecast.shutdown().then(() => process.exit(0));
});
