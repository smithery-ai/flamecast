import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.js";
import { tunnels } from "./routes/tunnels.js";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true }));

app.route("/api/tunnels", tunnels);

export { app };
