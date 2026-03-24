import { pathToFileURL } from "node:url";
import { Flamecast } from "@flamecast/sdk";
import { createPsqlStorage } from "@flamecast/storage-psql";

export async function main() {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL or POSTGRES_URL is required. Use 'pnpm alchemy:dev' for local development.",
    );
  }
  const flamecast = new Flamecast({
    storage: await createPsqlStorage({ url }),
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
