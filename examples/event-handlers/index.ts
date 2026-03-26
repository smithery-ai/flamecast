#!/usr/bin/env npx tsx
/**
 * Example: Event Handlers
 *
 * Starts a Flamecast server, creates a session, sends a prompt via REST,
 * and logs all handler activity. Fully self-contained — just run:
 *
 *   cd examples/event-handlers
 *   npx tsx index.ts
 */
import { serve } from "@hono/node-server";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";

const PORT = 3001;
const BASE = `http://localhost:${PORT}/api`;

const flamecast = new Flamecast({
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

  onPermissionRequest: async (c) => {
    console.log("\n>>> PERMISSION REQUEST");
    console.log(`    ${c.title} [${c.options.map((o) => o.name).join(" / ")}]`);
    console.log(`    → Auto-approving`);
    return c.allow();
  },

  onSessionEnd: async (c) => {
    console.log(`\n>>> SESSION ENDED (${c.reason})`);
  },

  onAgentMessage: async (c) => {
    console.log(`\n>>> AGENT MESSAGE: ${JSON.stringify(c.data).slice(0, 200)}`);
  },

  onError: async (c) => {
    console.log(`\n>>> ERROR: ${c.error.message}`);
  },
});

// Start server, then run the test flow
const server = serve({ fetch: flamecast.app.fetch, port: PORT }, async () => {
  console.log(`Flamecast running on http://localhost:${PORT}\n`);

  try {
    // 1. Create session
    console.log("--- Creating session ---");
    const createRes = await fetch(`${BASE}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentTemplateId: "example" }),
    });
    const session = await createRes.json();
    console.log(`Session: ${session.id} (${session.agentName})`);

    // 2. Send prompt via REST
    console.log("\n--- Sending prompt ---");
    const promptRes = await fetch(`${BASE}/agents/${session.id}/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "write a file to disk" }),
    });
    const promptResult = await promptRes.json();
    console.log(`Prompt result:`, JSON.stringify(promptResult).slice(0, 200));

    // 3. Terminate
    console.log("\n--- Terminating session ---");
    await fetch(`${BASE}/agents/${session.id}`, { method: "DELETE" });

    console.log("\n--- Done ---");
  } catch (err) {
    console.error("Test failed:", err);
  }

  // Give handlers a moment to fire, then exit
  setTimeout(() => {
    server.close();
    flamecast.shutdown().then(() => process.exit(0));
  }, 1000);
});
