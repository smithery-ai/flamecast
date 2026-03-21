import alchemy from "alchemy";
import { Vite } from "alchemy/cloudflare";
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
// Flamecast — API + Frontend via Vite
// ---------------------------------------------------------------------------

export const server = await Vite("flamecast", {
  name: `flamecast-${app.stage}`,
  bindings: {
    DATABASE_URL,
  },
});

await app.finalize();

export { db };
