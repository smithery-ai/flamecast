/**
 * Example: Queue Drain
 *
 * Rapid-fires 5 prompts at an agent and watches the queue drain in
 * real time. Demonstrates serial execution with automatic dequeue.
 *
 * Run:
 *   pnpm --filter @flamecast/session-host --filter @flamecast/example-queue-drain dev
 */
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { EXAMPLE_TEMPLATE, startServer } from "@flamecast/example-shared/create-example.js";

const PROMPTS = [
  "list files in the current directory",
  "create a file called hello.txt with 'hello world'",
  "read hello.txt",
  "delete hello.txt",
  "confirm hello.txt is deleted",
];

const flamecast = new Flamecast({
  runtimes: { default: new NodeRuntime() },
  agentTemplates: [EXAMPLE_TEMPLATE],
  onPermissionRequest: async (c) => {
    console.log(`  [auto-approve] ${c.title}`);
    return c.allow();
  },
});

await startServer(flamecast, async (apiUrl) => {
  console.log();
  console.log("  Queue Drain Demo");
  console.log("  " + "─".repeat(40));

  // 1. Create session
  process.stdout.write("  Creating session...  ");
  const createRes = await fetch(`${apiUrl}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentTemplateId: "example" }),
  });
  const session = await createRes.json();
  if (!createRes.ok) throw new Error(JSON.stringify(session));
  console.log(`✓ ${session.id}`);
  console.log();

  // 2. Fire first prompt (executes immediately)
  console.log(`  Sending ${PROMPTS.length} prompts...`);
  const firstRes = await fetch(`${apiUrl}/agents/${session.id}/prompts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: PROMPTS[0] }),
  });
  await firstRes.json();
  if (firstRes.status === 200) {
    console.log(`  [1] "${PROMPTS[0]}" → executing`);
  }

  // 3. Fire remaining prompts (should queue since agent is busy)
  for (let i = 1; i < PROMPTS.length; i++) {
    const res = await fetch(`${apiUrl}/agents/${session.id}/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: PROMPTS[i] }),
    });
    const result = await res.json();
    if (res.status === 202 && result.queued) {
      console.log(`  [${i + 1}] "${PROMPTS[i]}" → queued (position ${result.position})`);
    } else {
      console.log(`  [${i + 1}] "${PROMPTS[i]}" → executing (agent was idle)`);
    }
  }

  // 4. Poll queue state and watch it drain
  console.log();
  console.log("  Watching queue drain...");
  console.log();

  let lastSize = -1;
  let lastProcessing = false;
  let done = false;

  while (!done) {
    const qRes = await fetch(`${apiUrl}/agents/${session.id}/queue`);
    if (!qRes.ok) break;
    const q = await qRes.json();

    if (q.size !== lastSize || q.processing !== lastProcessing) {
      const status = q.processing ? "processing" : "idle";
      const queued = q.size > 0 ? `${q.size} queued` : "empty";
      console.log(`  [queue] ${status} · ${queued}`);

      if (q.size > 0) {
        for (const item of q.items) {
          console.log(`          #${item.position} "${item.text}"`);
        }
      }

      lastSize = q.size;
      lastProcessing = q.processing;
    }

    if (!q.processing && q.size === 0) {
      done = true;
    } else {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log();
  console.log("  ✓ All prompts complete");
  console.log();
});
