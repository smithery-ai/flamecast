import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Flamecast, NodeRuntime, listen } from "@flamecast/sdk";
import { DockerRuntime } from "@flamecast/runtime-docker";
import { E2BRuntime } from "@flamecast/runtime-e2b";
import { createPsqlStorage } from "@flamecast/storage-psql";
import dotenv from "dotenv";

dotenv.config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(__dirname, "../agent.ts"), "utf8");

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
const e2bApiKey = process.env.E2B_API_KEY;
const agentJsBaseUrl = process.env.FLAMECAST_AGENT_JS_BASE_URL;
const agentJsRuntime = agentJsBaseUrl ? new NodeRuntime(agentJsBaseUrl) : null;
const agentJsTemplate = agentJsRuntime
  ? {
      id: "agentjs",
      name: "Agent.js",
      spawn: { command: "remote-sessionhost", args: ["agentjs"] },
      runtime: { provider: "agentjs" },
    }
  : null;

const flamecast = new Flamecast({
  storage: await createPsqlStorage(url ? { url } : undefined),
  runtimes: {
    default: new NodeRuntime(),
    ...(agentJsRuntime ? { agentjs: agentJsRuntime } : {}),
    docker: new DockerRuntime(),
    ...(e2bApiKey ? { e2b: new E2BRuntime({ apiKey: e2bApiKey }) } : {}),
  },
  agentTemplates: [
    {
      id: "echo-agent",
      name: "Echo Agent",
      spawn: { command: "npx", args: ["tsx", resolve(__dirname, "../agent.ts")] },
      runtime: { provider: "default" },
    },
    {
      id: "docker-agent",
      name: "Docker Agent",
      spawn: { command: "npx", args: ["tsx", "agent.ts"] },
      runtime: {
        provider: "docker",
        setup: [
          "npm install tsx @agentclientprotocol/sdk",
          `cat > /workspace/agent.ts << 'AGENT_EOF'\n${agentSource}\nAGENT_EOF`,
        ].join(" && "),
      },
    },
    ...(e2bApiKey
      ? [
          {
            id: "e2b-agent",
            name: "E2B Agent",
            spawn: { command: "npx", args: ["tsx", "agent.ts"] },
            runtime: {
              provider: "e2b",
              setup: [
                "npm install tsx @agentclientprotocol/sdk",
                `cat > /workspace/agent.ts << 'AGENT_EOF'\n${agentSource}\nAGENT_EOF`,
              ].join(" && "),
            },
          },
        ]
      : []),
    ...(agentJsTemplate ? [agentJsTemplate] : []),
  ],
});

listen(flamecast, { port: 3001 }, (info) => {
  console.log(`Flamecast running on http://localhost:${info.port}`);
});

// Graceful close: tear down in-process resources but leave sessions alive so
// they can be recovered on the next startup via recoverSessions().
process.on("SIGINT", () => {
  flamecast.close().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  flamecast.close().then(() => process.exit(0));
});
