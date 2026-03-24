import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Flamecast } from "@flamecast/sdk";
import { createPsqlStorage } from "@flamecast/storage-psql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exampleAgentPath = path.resolve(__dirname, "../../packages/flamecast/src/flamecast/agent.ts");

export async function main() {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  const flamecast = new Flamecast({
    storage: await createPsqlStorage(url ? { url } : undefined),
    agentTemplates: [
      {
        id: "example",
        name: "Example agent",
        spawn: { command: "pnpm", args: ["exec", "tsx", exampleAgentPath] },
        runtime: { provider: "local" },
      },
    ],
  });
  await flamecast.listen(3001);
  return flamecast;
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  void main();
}
