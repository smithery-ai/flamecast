/**
 * Example: Event Handlers
 *
 * Demonstrates all four Flamecast event handlers:
 *   onPermissionRequest, onSessionEnd, onAgentMessage, onError
 *
 * Run with: pnpm dev  (from repo root — turbo starts this alongside session-host)
 *
 * Then test:
 *   curl -s -X POST http://localhost:3002/api/agents \
 *     -H 'Content-Type: application/json' \
 *     -d '{"agentTemplateId": "example"}' | jq .
 *
 *   curl -s -X POST http://localhost:3002/api/agents/SESSION_ID/prompts \
 *     -H 'Content-Type: application/json' \
 *     -d '{"text": "write a file to disk"}' | jq .
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(__dirname, "../../packages/flamecast/src/flamecast/agent.ts");
const PORT = 3002;

const flamecast = new Flamecast({
  runtimes: {
    default: new NodeRuntime(),
  },
  agentTemplates: [
    {
      id: "example",
      name: "Example agent",
      spawn: { command: "pnpm", args: ["exec", "tsx", agentPath] },
      runtime: { provider: "default" },
    },
  ],

  onPermissionRequest: async (c) => {
    console.log(`[handler] PERMISSION: "${c.title}" → auto-approving`);
    return c.allow();
  },

  onSessionEnd: async (c) => {
    console.log(`[handler] SESSION ENDED (${c.reason})`);
  },

  onAgentMessage: async (c) => {
    console.log(`[handler] AGENT MESSAGE: ${JSON.stringify(c.data).slice(0, 200)}`);
  },

  onError: async (c) => {
    console.log(`[handler] ERROR: ${c.error.message}`);
  },
});

serve({ fetch: flamecast.app.fetch, port: PORT }, () => {
  console.log(`Event handlers example running on http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  flamecast.shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  flamecast.shutdown().then(() => process.exit(0));
});
