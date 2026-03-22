import { Generator, getConfig } from "@tanstack/router-generator";

async function main() {
  const root = process.cwd();
  const config = getConfig(
    {
      routesDirectory: "./src/client/routes",
      generatedRouteTree: "./src/client/routeTree.gen.ts",
    },
    root,
  );

  const generator = new Generator({ root, config });
  await generator.run();
}

await main();
