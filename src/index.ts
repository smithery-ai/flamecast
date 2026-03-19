#!/usr/bin/env node

import { Flamecast } from "./flamecast";

async function main() {
  const flamecast = new Flamecast();

  const conn = await flamecast.create({ agent: "codex" });
  console.log(`✅ Connection ${conn.id} started at ${conn.startedAt.toISOString()}`);
  console.log(`📝 Session: ${conn.sessionId}`);
  console.log(
    `📋 Active connections:`,
    flamecast.list().map((c) => c.id),
  );

  const info = flamecast.get(conn.id);
  console.log(`\n🔎 Connection info:`);
  console.log(`   Started at:      ${info.startedAt.toISOString()}`);
  console.log(`   Last updated at: ${info.lastUpdatedAt.toISOString()}`);

  console.log(`\n💬 Sending prompt...\n`);
  const promptPromise = flamecast.prompt(conn.id, "what files are in the current directory?");
  let result;
  while (true) {
    // Wait for a second before checking the promise resolution
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (promptPromise instanceof Promise) {
      const isSettled = await Promise.race([
        promptPromise.then(() => true).catch(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 0)),
      ]);
      if (isSettled) {
        result = await promptPromise;
        break;
      }
    }
    console.log(
      "\n\n",
      flamecast
        .getLogs(conn.id)
        .map((l) => JSON.stringify(l))
        .join("\n"),
      "\n\n",
    );
  }
  console.log(`\n✅ Agent completed with: ${result.stopReason}`);

  console.log(`\n📜 Connection logs (${flamecast.getLogs(conn.id).length} entries):`);
  for (const log of flamecast.getLogs(conn.id)) {
    console.log(`   [${log.timestamp}] ${log.type}`, JSON.stringify(log.data));
  }

  flamecast.kill(conn.id);
  console.log(`\n🗑️  Connection ${conn.id} killed`);
  console.log(
    `📋 Active connections:`,
    flamecast.list().map((c) => c.id),
  );

  process.exit(0);
}

main().catch(console.error);
