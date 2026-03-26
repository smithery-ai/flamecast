/**
 * Creates a session, sends a prompt, and prints the result.
 * Called after both servers are ready.
 */
export async function runDemo(baseUrl: string): Promise<void> {
  console.log();
  console.log("  Webhooks and Signaling");
  console.log("  " + "─".repeat(40));

  const start = Date.now();

  process.stdout.write("  Creating session...  ");
  const createRes = await fetch(`${baseUrl}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentTemplateId: "example" }),
  });
  const session = await createRes.json();
  if (!createRes.ok) throw new Error(JSON.stringify(session));
  console.log(`✓ ${session.id}`);

  const prompt = "write hello world to /tmp/test.txt";
  console.log(`  Sending prompt: "${prompt}"`);

  const promptRes = await fetch(`${baseUrl}/agents/${session.id}/prompts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: prompt }),
  });
  const result = await promptRes.json();
  if (!promptRes.ok) throw new Error(JSON.stringify(result));
  console.log(`  → Agent completed`);

  await new Promise((r) => setTimeout(r, 500));

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  Done in ${elapsed}s`);
  console.log();
}
