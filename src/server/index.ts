import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { createApi } from "./api.js";
import { createSlackRoutes } from "./integrations/slack.js";
import { flamecast, slackInstaller } from "./runtime.js";

const app = new Hono();

app.route("/api", createApi(flamecast, slackInstaller));
app.route("/api", createSlackRoutes(slackInstaller));

const honoListener = getRequestListener(app.fetch);

const server = createServer((req, res) => {
  honoListener(req, res).catch((error) => {
    console.error("Server request failed:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal server error");
      return;
    }
    res.end();
  });
});

server.listen(3001, () => {
  console.log("🔥 API server running on http://localhost:3001");
});
