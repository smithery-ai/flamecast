#!/usr/bin/env node

import { serve } from "@hono/node-server";
import { AgentJsRuntime, Flamecast, NodeRuntime } from "./index.js";

function parsePort(value: string | undefined): number {
  if (!value) return 3001;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid port "${value}"`);
  }
  return parsed;
}

const port = parsePort(process.env.FLAMECAST_PORT ?? process.env.PORT);

const flamecast = new Flamecast({
  runtimes: {
    default: new NodeRuntime(),
    agentjs: new AgentJsRuntime({
      baseUrl: process.env.FLAMECAST_AGENT_JS_BASE_URL,
      websocketUrl: process.env.FLAMECAST_AGENT_JS_WEBSOCKET_URL,
    }),
  },
});

const server = serve({ fetch: flamecast.app.fetch, port }, () => {
  console.log(`Flamecast running on http://localhost:${port}`);
  console.log(`API: http://localhost:${port}/api`);
});

async function shutdown() {
  console.log("\nShutting down...");
  await flamecast.shutdown();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
