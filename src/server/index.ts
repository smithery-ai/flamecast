import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createFlamecast } from "./flamecast/config.js";
import { createApi } from "./flamecast/api.js";

const flamecast = await createFlamecast();
const api = createApi(flamecast);
const app = new Hono();
app.route("/api", api);

serve({ fetch: app.fetch, port: 3001 }, (info) => {
  console.log(`Flamecast running on http://localhost:${info.port}`);
});
