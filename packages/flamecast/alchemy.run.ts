import alchemy from "alchemy";
import { Worker, Vite } from "alchemy/cloudflare";
import * as docker from "alchemy/docker";

const app = await alchemy("flamecast-infra");

// ---------------------------------------------------------------------------
// Database — Postgres in Docker
// ---------------------------------------------------------------------------

const db = await docker.Container("flamecast-db", {
  adopt: true,
  image: "postgres:16",
  name: `flamecast-db-${app.stage}`,
  environment: {
    POSTGRES_USER: "flamecast",
    POSTGRES_PASSWORD: "flamecast",
    POSTGRES_DB: "flamecast",
  },
  ports: [{ external: 5432, internal: 5432 }],
  restart: "unless-stopped",
  start: true,
});

const DATABASE_URL = `postgres://flamecast:flamecast@localhost:5432/flamecast`;

// ---------------------------------------------------------------------------
// API server
// ---------------------------------------------------------------------------

export const server = await Worker("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  entrypoint: "./src/worker.ts",
  format: "esm",
  compatibility: "node",
  bindings: {
    DATABASE_URL,
  },
  url: true,
  dev: {
    port: 3001,
  },
});

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

export const client = await Vite("flamecast-client", {
  name: `flamecast-client-${app.stage}`,
});

console.log(`API: ${server.url}`);

await app.finalize();

export { db };
