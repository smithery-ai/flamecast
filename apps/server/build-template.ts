/**
 * Build the flamecast-node22 E2B sandbox template.
 *
 * Usage:
 *   pnpm build-template          (reads E2B_API_KEY from .env)
 *   E2B_API_KEY=<key> pnpm build-template
 *
 * After building, use the template name "flamecast-node22" in E2BRuntime.
 */
import "dotenv/config";
import { Template, defaultBuildLogger } from "e2b";

const template = Template().fromImage("node:22-slim");

async function main() {
  const result = await Template.build(template, "flamecast-node22", {
    cpuCount: 2,
    memoryMB: 512,
    onBuildLogs: defaultBuildLogger(),
  });
  console.log("\nTemplate built successfully!");
  console.log(`  Name: flamecast-node22`);
  console.log(`  ID:   ${result.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
