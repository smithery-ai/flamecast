import alchemy from "alchemy";
import { serve } from "@hono/node-server";
import { createFlamecast } from "../flamecast/config.js";
import { createServerApp } from "./app.js";

// Init alchemy at startup — provides scope for per-connection provisioning
await alchemy("flamecast", { phase: "up", quiet: true });

const flamecast = await createFlamecast();
const app = createServerApp(flamecast);

const server = serve({ fetch: app.fetch, port: 3001 }, (info) => {
  console.log(`Flamecast running on http://localhost:${info.port}`);
});

async function shutdown() {
  console.log("\nShutting down...");
  for (const conn of await flamecast.list()) {
    await flamecast.kill(conn.id).catch(() => {});
  }
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
