import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Flamecast, NodeRuntime, listen } from "@flamecast/sdk";
import { createPsqlStorage } from "@flamecast/storage-psql";
import dotenv from "dotenv";
import { createAgentTemplates } from "./agent-templates.js";

dotenv.config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(__dirname, "../agent.ts"), "utf8");

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
const e2bApiKey = process.env.E2B_API_KEY;
const agentJsBaseUrl = process.env.FLAMECAST_AGENT_JS_BASE_URL;
const agentJsRuntime = agentJsBaseUrl ? new NodeRuntime(agentJsBaseUrl) : null;

// Optional runtimes — only loaded when their packages and dependencies are present.
const DockerRuntime = await import("@flamecast/runtime-docker")
  .then((m) => m.DockerRuntime)
  .catch(() => null);

const E2BRuntime =
  e2bApiKey
    ? await import("@flamecast/runtime-e2b")
        .then((m) => m.E2BRuntime)
        .catch(() => null)
    : null;

const dockerRuntime = DockerRuntime ? new DockerRuntime() : null;
const e2bRuntime =
  E2BRuntime && e2bApiKey
    ? new E2BRuntime({ apiKey: e2bApiKey, template: "flamecast-node22" })
    : null;

if (!DockerRuntime) {
  console.warn("[Flamecast] Docker runtime unavailable (missing dependencies) — skipping.");
}

const flamecast = new Flamecast({
  storage: await createPsqlStorage(url ? { url } : undefined),
  runtimes: {
    default: new NodeRuntime(),
    ...(agentJsRuntime ? { agentjs: agentJsRuntime } : {}),
    ...(dockerRuntime ? { docker: dockerRuntime } : {}),
    ...(e2bRuntime ? { e2b: e2bRuntime } : {}),
  },
  agentTemplates: createAgentTemplates({
    agentJsEnabled: agentJsRuntime !== null,
    dockerEnabled: dockerRuntime !== null,
    e2bEnabled: e2bRuntime !== null,
    hostAgentPath: resolve(__dirname, "../agent.ts"),
    agentSource,
  }),
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
