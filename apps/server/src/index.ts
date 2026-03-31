import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Flamecast, NodeRuntime, listen } from "@flamecast/sdk";
import { DockerRuntime } from "@flamecast/runtime-docker";
import { E2BRuntime } from "@flamecast/runtime-e2b";
import { createPsqlStorage } from "@flamecast/storage-psql";
import { RestateSessionService, RestateStorage } from "@flamecast/restate";
import dotenv from "dotenv";
import { createAgentTemplates } from "./agent-templates.js";

dotenv.config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(__dirname, "../agent.ts"), "utf8");

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
const e2bApiKey = process.env.E2B_API_KEY;
const agentJsBaseUrl = process.env.FLAMECAST_AGENT_JS_BASE_URL;
const agentJsRuntime = agentJsBaseUrl ? new NodeRuntime(agentJsBaseUrl) : null;
const runtimes = {
  default: new NodeRuntime(),
  ...(agentJsRuntime ? { agentjs: agentJsRuntime } : {}),
  docker: new DockerRuntime(),
  ...(e2bApiKey
    ? { e2b: new E2BRuntime({ apiKey: e2bApiKey, template: "flamecast-node22" }) }
    : {}),
};

// ---------------------------------------------------------------------------
// Restate — ports configured in packages/flamecast-restate/restate.toml
// ---------------------------------------------------------------------------

const restateIngressUrl = process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080";
const restateAdminUrl = process.env.RESTATE_ADMIN_URL ?? "http://localhost:19070";

// ---------------------------------------------------------------------------
// Flamecast instance
// ---------------------------------------------------------------------------

const pgStorage = await createPsqlStorage(url ? { url } : undefined);

const flamecast = new Flamecast({
  storage: new RestateStorage(restateAdminUrl, pgStorage),
  runtimes,
  sessionService: new RestateSessionService(runtimes, restateIngressUrl),
  agentTemplates: createAgentTemplates({
    agentJsEnabled: agentJsRuntime !== null,
    e2bEnabled: Boolean(e2bApiKey),
    hostAgentPath: resolve(__dirname, "../agent.ts"),
    agentSource,
  }),
});

listen(flamecast, { port: 3001 }, (info) => {
  console.log(`Flamecast running on http://localhost:${info.port}`);
  console.log(`  Sessions: Restate-backed (durable)`);
});

async function shutdown() {
  await flamecast.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
