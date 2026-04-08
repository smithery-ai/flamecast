import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const sha = process.env.COMMIT_SHA?.slice(0, 7);
if (!sha) {
  console.error("COMMIT_SHA environment variable is required");
  process.exit(1);
}

const packagesDir = "packages";

for (const dir of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, dir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    continue;
  }
  if (pkg.private) continue;

  pkg.version = `${pkg.version}-alpha.${sha}`;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${pkg.name}@${pkg.version}`);
}
