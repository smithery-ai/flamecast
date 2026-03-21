import { Hono } from "hono";
import { createFlamecast } from "./flamecast/config.js";
import { createApi } from "./flamecast/api.js";

let app: Hono | null = null;

async function getApp() {
  if (!app) {
    const flamecast = await createFlamecast({
      stateManager: { type: "memory" },
    });
    app = new Hono();
    app.route("/api", createApi(flamecast));
  }
  return app;
}

export default {
  async fetch(request: Request) {
    const handler = await getApp();
    return handler.fetch(request);
  },
};
