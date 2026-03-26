/**
 * Example: Headless Agent Runner
 *
 * Creates a session, sends a prompt, handles permissions, and prints the
 * result — all over HTTP, no WebSocket, no browser.
 *
 * Run:
 *   pnpm --filter @flamecast/session-host --filter @flamecast/example-headless dev
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Flamecast, NodeRuntime } from "@flamecast/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(__dirname, "../../packages/flamecast/src/flamecast/agent.ts");
const PORT = 3003;
const BASE = `http://localhost:${PORT}/api`;

const flamecast = new Flamecast({
  runtimes: { default: new NodeRuntime() },
  agentTemplates: [
    {
      id: "example",
      name: "Example agent",
      spawn: { command: "pnpm", args: ["exec", "tsx", agentPath] },
      runtime: { provider: "default" },
    },
  ],
  onPermissionRequest: async (c) => {
    console.log(`  → Permission: "${c.title}" — approved`);
    return c.allow();
  },
});

serve({ fetch: flamecast.app.fetch, port: PORT }, async () => {
  console.log();
  console.log("  Headless Agent Runner");
  console.log("  " + "─".repeat(40));

  const start = Date.now();

  try {
    process.stdout.write("  Creating session...  ");
    const createRes = await fetch(`${BASE}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentTemplateId: "example" }),
    });
    const session = await createRes.json();
    if (!createRes.ok) throw new Error(JSON.stringify(session));
    console.log(`✓ ${session.id}`);

    const prompt = "write hello world to /tmp/test.txt";
    console.log(`  Sending prompt: "${prompt}"`);

    const promptRes = await fetch(`${BASE}/agents/${session.id}/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
    });
    const result = await promptRes.json();
    if (!promptRes.ok) throw new Error(JSON.stringify(result));
    console.log(`  → Agent completed`);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  Done in ${elapsed}s`);
  } catch (err) {
    console.error(`  ✗ Failed: ${err}`);
  }

  console.log();
  await flamecast.shutdown();
  process.exit(0);
});
