import { serve } from "@hono/node-server";
import { Hono } from "hono";
import api from "./api.js";

const app = new Hono();

app.route("/api", api);

serve({ fetch: app.fetch, port: 3001 }, (info) => {
  console.log(`🔥 API server running on http://localhost:${info.port}`);
});
