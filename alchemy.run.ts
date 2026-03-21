import alchemy from "alchemy";
import * as docker from "alchemy/docker";
import { Exec } from "alchemy/os";
import { PGLite } from "./src/flamecast/resources/pglite.js";

const app = await alchemy("flamecast-infra");

// ---------------------------------------------------------------------------
// Database — pick one
// ---------------------------------------------------------------------------

// Option A: PGLite (zero-dep, no Docker needed)
const pgliteDb = await PGLite("flamecast-db");

// Option B: Docker Postgres (uncomment to use)
// const dbNetwork = await docker.Network("db-network", {
//   name: `flamecast-db-${app.stage}`,
//   driver: "bridge",
// });
// const postgresDb = await docker.Container("flamecast-db", {
//   image: "postgres:16-alpine",
//   name: `flamecast-db-${app.stage}`,
//   environment: {
//     POSTGRES_USER: "flamecast",
//     POSTGRES_PASSWORD: "flamecast",
//     POSTGRES_DB: "flamecast",
//   },
//   ports: [{ external: 5433, internal: 5432 }],
//   networks: [{ name: dbNetwork.name }],
//   restart: "unless-stopped",
//   start: true,
// });

await app.finalize();

export { pgliteDb };
