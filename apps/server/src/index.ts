import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Flamecast, NodeRuntime, listen } from "@flamecast/sdk";
import { DockerRuntime } from "@flamecast/runtime-docker";
import { E2BRuntime } from "@flamecast/runtime-e2b";
import { createPsqlStorage } from "@flamecast/storage-psql";
import dotenv from "dotenv";
import { createAgentTemplates } from "./agent-templates.js";

dotenv.config();

const USE_NONLOCAL_RUNTIMES = process.env.USE_NONLOCAL_RUNTIMES === "true";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(__dirname, "../agent.ts"), "utf8");

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
const e2bApiKey = process.env.E2B_API_KEY;
const agentJsBaseUrl = process.env.FLAMECAST_AGENT_JS_BASE_URL;
const agentJsRuntime = agentJsBaseUrl ? new NodeRuntime(agentJsBaseUrl) : null;

const flamecast = new Flamecast({
  storage: await createPsqlStorage(url ? { url } : undefined),
  runtimes: {
    local: new NodeRuntime({ cwd: homedir() }),
    ...(USE_NONLOCAL_RUNTIMES
      ? {
          ...(agentJsRuntime ? { agentjs: agentJsRuntime } : {}),
          docker: new DockerRuntime(),
          ...(e2bApiKey
            ? { e2b: new E2BRuntime({ apiKey: e2bApiKey, template: "flamecast-node22" }) }
            : {}),
        }
      : {}),
  },
  agentTemplates: createAgentTemplates({
    dockerEnabled: USE_NONLOCAL_RUNTIMES,
    agentJsEnabled: USE_NONLOCAL_RUNTIMES && agentJsRuntime !== null,
    e2bEnabled: USE_NONLOCAL_RUNTIMES && Boolean(e2bApiKey),
    hostAgentPath: resolve(__dirname, "../agent.ts"),
    agentSource,
  }),
});

listen(flamecast, { port: 3001, cors: true }, (info) => {
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
