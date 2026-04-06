import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { DockerRuntime } from "@flamecast/runtime-docker";
import { E2BRuntime } from "@flamecast/runtime-e2b";
import { createPsqlDatabase } from "@flamecast/storage-psql";
import { createAgentTemplates } from "./src/agent-templates.js";

dotenv.config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(__dirname, "./agent.ts"), "utf8");
const e2bApiKey = process.env.E2B_API_KEY;
const agentJsBaseUrl = process.env.FLAMECAST_AGENT_JS_BASE_URL;
const agentJsRuntime = agentJsBaseUrl ? new NodeRuntime(agentJsBaseUrl) : null;
const db = createPsqlDatabase({
  url: process.env.DATABASE_URL ?? process.env.POSTGRES_URL,
});

export default new Flamecast({
  backend: db,
  runtimes: {
    default: new NodeRuntime(),
    ...(agentJsRuntime ? { agentjs: agentJsRuntime } : {}),
    docker: new DockerRuntime(),
    ...(e2bApiKey
      ? { e2b: new E2BRuntime({ apiKey: e2bApiKey, template: "flamecast-node22" }) }
      : {}),
  },
  agentTemplates: createAgentTemplates({
    agentJsEnabled: agentJsRuntime !== null,
    e2bEnabled: Boolean(e2bApiKey),
    hostAgentPath: resolve(__dirname, "./agent.ts"),
    agentSource,
  }),
});
