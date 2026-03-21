import { Hono } from "hono";
import { createFlamecast } from "./flamecast/config.js";
import { createApi } from "./flamecast/api.js";
import type { server } from "../alchemy.run";

type Env = typeof server.Env;

const app = new Hono<{ Bindings: Env }>();

const flamecast = await createFlamecast({
  stateManager: { type: "memory" }, // TODO: wire D1 state manager from env.DB
});

app.route("/api", createApi(flamecast));

export default app;
