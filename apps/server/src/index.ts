import { Flamecast, NodeRuntime, listen } from "@flamecast/sdk";
import dotenv from "dotenv";
import { createAgentTemplates } from "./agent-templates.js";

dotenv.config();

const restateIngressUrl = process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080";

const runtimes = {
  default: new NodeRuntime(),
};

const flamecast = new Flamecast({
  runtimes,
  agentTemplates: createAgentTemplates(),
  restateUrl: restateIngressUrl,
});

listen(flamecast, { port: 3001 }, (info) => {
  console.log(`Flamecast running on http://localhost:${info.port}`);
  console.log(`  Restate ingress: ${restateIngressUrl}`);
});

async function shutdown() {
  await flamecast.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
