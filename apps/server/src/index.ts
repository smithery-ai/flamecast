import { serve } from "@hono/node-server";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { createPsqlStorage } from "@flamecast/storage-psql";

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

const flamecast = new Flamecast({
  storage: await createPsqlStorage(url ? { url } : undefined),
  runtimes: {
    default: new NodeRuntime(),
  },
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
