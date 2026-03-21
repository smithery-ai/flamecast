import { Hono } from "hono";
import { createFlamecast } from "./flamecast/config.js";
import { createApi } from "./flamecast/api.js";

const flamecast = await createFlamecast({
  stateManager: { type: "memory" },
});

const app = new Hono();
app.route("/api", createApi(flamecast));

export default app;
