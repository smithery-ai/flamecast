#!/usr/bin/env node

import { mkdirSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import prompts from "prompts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const templateDir = resolve(__dirname, "../template");

async function main() {
  const targetDir = process.argv[2];

  const response = await prompts(
    [
      {
        type: targetDir ? null : "text",
        name: "projectName",
        message: "Project name:",
        initial: "my-flamecast-server",
      },
    ],
    { onCancel: () => process.exit(1) },
  );

  const projectName = targetDir ?? response.projectName;
  const root = resolve(process.cwd(), projectName);

  console.log(`\nScaffolding Flamecast server in ${root}...\n`);

  mkdirSync(root, { recursive: true });
  cpSync(templateDir, root, { recursive: true });

  // Update package.json name
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = basename(projectName);
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  console.log("Done! Now run:\n");
  console.log(`  cd ${projectName}`);
  console.log("  npm install");
  console.log("  npm run dev\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
