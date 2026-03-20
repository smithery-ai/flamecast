import { serve } from "@hono/node-server";
import { Hono } from "hono";
import api from "./api.js";
import { integrations } from "./runtime.js";

const app = new Hono();

app.route("/api", api);
app.route("/api", integrations.platformBridge.routes);
app.route("/api", integrations.linearAgentRoutes);
app.route("/api/integrations", integrations.proxyRoutes);

serve({ fetch: app.fetch, port: 3001 }, (info) => {
  console.log(`🔥 API server running on http://localhost:${info.port}`);
});
