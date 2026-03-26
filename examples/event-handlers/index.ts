#!/usr/bin/env npx tsx
/**
 * Example: Event Handlers
 *
 * Demonstrates all four Flamecast event handlers wired via the
 * session-host → control plane callback mechanism.
 *
 * Usage:
 *   cd examples/event-handlers
 *   npx tsx index.ts
 *
 * Then test with curl (or run ./test.sh):
 *
 *   # Create a session
 *   curl -s -X POST http://localhost:3001/api/agents \
 *     -H 'Content-Type: application/json' \
 *     -d '{"agentTemplateId": "example"}' | jq .
 *
 *   # Send a prompt via REST (use the session ID from above)
 *   curl -s -X POST http://localhost:3001/api/agents/SESSION_ID/prompts \
 *     -H 'Content-Type: application/json' \
 *     -d '{"text": "write a file to disk"}' | jq .
 *
 *   # Terminate
 *   curl -s -X DELETE http://localhost:3001/api/agents/SESSION_ID | jq .
 *
 * Watch the terminal for handler output.
 */
import { serve } from "@hono/node-server";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";

const PORT = 3001;

const flamecast = new Flamecast({
  // Omit storage — defaults to in-memory
  // callbackUrl is auto-detected from incoming requests
  runtimes: {
    default: new NodeRuntime(),
  },
  agentTemplates: [
    {
      id: "example",
      name: "Example agent",
      spawn: { command: "npx", args: ["tsx", "../../packages/flamecast/src/flamecast/agent.ts"] },
      runtime: { provider: "default" },
    },
  ],

  // -----------------------------------------------------------------------
  // Event handlers — these fire when the session-host calls back
  // -----------------------------------------------------------------------

  onPermissionRequest: async (c) => {
    console.log("\n=== PERMISSION REQUEST ===");
    console.log(`  Session:  ${c.session.id}`);
    console.log(`  Agent:    ${c.session.agentName}`);
    console.log(`  Title:    ${c.title}`);
    console.log(`  Kind:     ${c.kind ?? "(none)"}`);
    console.log(`  Options:  ${c.options.map((o) => `${o.name} (${o.kind})`).join(", ")}`);
    console.log(`  → Auto-approving`);
    return c.allow();
  },

  onSessionEnd: async (c) => {
    console.log("\n=== SESSION ENDED ===");
    console.log(`  Session:  ${c.session.id}`);
    console.log(`  Agent:    ${c.session.agentName}`);
    console.log(`  Reason:   ${c.reason}`);
  },

  onAgentMessage: async (c) => {
    console.log("\n=== AGENT MESSAGE ===");
    console.log(`  Session:  ${c.session.id}`);
    console.log(`  Type:     ${c.type}`);
    console.log(`  Data:     ${JSON.stringify(c.data).slice(0, 200)}`);
  },

  onError: async (c) => {
    console.log("\n=== ERROR ===");
    console.log(`  Session:  ${c.session.id}`);
    console.log(`  Error:    ${c.error.message}`);
  },
});

serve({ fetch: flamecast.app.fetch, port: PORT }, () => {
  console.log(`Flamecast running on http://localhost:${PORT}`);
  console.log(`\nEvent handlers registered:`);
  console.log(`  onPermissionRequest  ✓ (auto-approve)`);
  console.log(`  onSessionEnd         ✓`);
  console.log(`  onAgentMessage       ✓`);
  console.log(`  onError              ✓`);
  console.log(`\nCreate a session to see handlers fire.`);
});

process.on("SIGINT", () => {
  flamecast.shutdown().then(() => process.exit(0));
});
