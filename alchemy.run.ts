import alchemy from "alchemy";
import * as docker from "alchemy/docker";
import { Exec } from "alchemy/os";

const app = await alchemy("flamecast-infra");

// ---------------------------------------------------------------------------
// Database — Postgres in Docker with Drizzle migrations
// ---------------------------------------------------------------------------

const dbNetwork = await docker.Network("db-network", {
  name: `flamecast-db-${app.stage}`,
  driver: "bridge",
});

const db = await docker.Container("flamecast-db", {
  image: "postgres:16-alpine",
  name: `flamecast-db-${app.stage}`,
  environment: {
    POSTGRES_USER: "flamecast",
    POSTGRES_PASSWORD: "flamecast",
    POSTGRES_DB: "flamecast",
  },
  ports: [{ external: 5433, internal: 5432 }],
  networks: [{ name: dbNetwork.name }],
  restart: "unless-stopped",
  start: true,
});

const DATABASE_URL = "postgres://flamecast:flamecast@localhost:5433/flamecast";

// Run Drizzle migrations at deploy time
await Exec("drizzle-migrate", {
  command: `npx drizzle-kit migrate --config src/flamecast/state-managers/psql/drizzle.config.ts`,
  env: {
    FLAMECAST_POSTGRES_URL: DATABASE_URL,
  },
});

await app.finalize();

export { db, dbNetwork, DATABASE_URL };
