import { Flamecast, NodeRuntime, listen } from "@flamecast/sdk";
import { createPsqlStorage } from "@flamecast/storage-psql";
import dotenv from "dotenv";

dotenv.config();
const storage = await createPsqlStorage();

const flamecast = new Flamecast({
  storage,
  runtimes: {
    default: new NodeRuntime(),
  },
  agentTemplates: [
    {
      id: "echo-agent",
      name: "Echo Agent",
      spawn: { command: "npx", args: ["tsx", "agent.ts"] },
      runtime: { provider: "default" },
    },
  ],
});

listen(flamecast, { port: 3001 }, (info) => {
  console.log(`Flamecast running on http://localhost:${info.port}`);
});

process.on("SIGINT", () => {
  flamecast.close().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  flamecast.close().then(() => process.exit(0));
});
