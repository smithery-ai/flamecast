import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { DockerRuntime } from "@flamecast/runtime-docker";
import { createPsqlStorage } from "@flamecast/storage-psql";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionHostDockerfile = resolve(__dirname, "../../../packages/session-host/Dockerfile");

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

const flamecast = new Flamecast({
  storage: await createPsqlStorage(url ? { url } : undefined),
  runtimes: {
    default: new NodeRuntime(),
    docker: new DockerRuntime(),
  },
  agentTemplates: [
    {
      id: "docker-session-host",
      name: "Docker Session Host",
      spawn: { command: "node", args: ["dist/index.js"] },
      runtime: {
        provider: "docker",
        image: "flamecast-session-host",
        dockerfile: sessionHostDockerfile,
      },
    },
  ],
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
