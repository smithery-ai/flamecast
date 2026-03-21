import alchemy from "alchemy";
import { D1Database, Worker } from "alchemy/cloudflare";

const app = await alchemy("flamecast-infra");

// Database — D1 with Drizzle migrations applied at deploy time
const db = await D1Database("flamecast-db", {
  name: `flamecast-db-${app.stage}`,
  migrationsDir: "./migrations",
});

// Server — Flamecast API as a Cloudflare Worker
export const server = await Worker("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  entrypoint: "./src/worker.ts",
  bindings: {
    DB: db,
  },
  url: true,
});

console.log(`Flamecast API: ${server.url}`);

await app.finalize();
