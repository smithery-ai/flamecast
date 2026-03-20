import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createApi } from "./api.js";
import { loadServerConfig } from "./config.js";
import { createPsqlStateManager } from "../flamecast/state-managers/psql/index.js";
import { MemoryFlamecastStateManager } from "../flamecast/state-managers/memory/index.js";
import { createDatabase } from "./db/client.js";
import { Flamecast } from "../flamecast/index.js";

const serverConfig = await loadServerConfig();
const stateManager =
  serverConfig.stateManager === "memory"
    ? new MemoryFlamecastStateManager()
    : createPsqlStateManager((await createDatabase()).db);
const flamecast = new Flamecast({ stateManager });
const api = createApi(flamecast);

const app = new Hono();

app.route("/api", api);

serve({ fetch: app.fetch, port: 3001 }, (info) => {
  console.log(`🔥 API server running on http://localhost:${info.port}`);
});
