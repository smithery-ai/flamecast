/**
 * Creates a session, sends a prompt, and prints the result.
 * Called after both servers are ready.
 */
import { createFlamecastClient } from "@flamecast/sdk/client";

export async function runDemo(baseUrl: string): Promise<void> {
  const client = createFlamecastClient({ baseUrl });

  console.log();
  console.log("  Webhooks and Signaling");
  console.log("  " + "─".repeat(40));

  const start = Date.now();

  process.stdout.write("  Creating session...  ");
  const session = await client.createSession({ agentTemplateId: "example" });
  console.log(`✓ ${session.id}`);

  const prompt = "write hello world to /tmp/test.txt";
  console.log(`  Sending prompt: "${prompt}"`);

  await client.promptSession(session.id, prompt);
  console.log(`  → Agent completed`);

  await new Promise((r) => setTimeout(r, 500));

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  Done in ${elapsed}s`);
  console.log();
}
