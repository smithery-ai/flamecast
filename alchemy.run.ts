import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";
import { PGLite } from "./src/flamecast/resources/pglite.js";

const app = await alchemy("flamecast-infra");

// Database
const db = await PGLite("flamecast-db");

// Server
export const server = await Worker("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  entrypoint: "./src/worker.ts",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    DATABASE_URL: db.connectionString,
  },
  url: true,
  dev: {
    port: 3001,
  },
});

console.log(`Flamecast API: ${server.url}`);

await app.finalize();

export { db };
