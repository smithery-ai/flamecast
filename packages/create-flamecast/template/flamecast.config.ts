import dotenv from "dotenv";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { createPsqlDatabase } from "@flamecast/storage-psql";

dotenv.config();
const db = createPsqlDatabase({
  url: process.env.DATABASE_URL ?? process.env.POSTGRES_URL,
});

export default new Flamecast({
  backend: db,
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
