import { pathToFileURL } from "node:url";
import { Flamecast } from "@flamecast/sdk";
import { createPsqlStorage } from "@flamecast/storage-psql";

export async function main() {
  // Pass { url: process.env.POSTGRES_URL } to use an external Postgres instance.
  // Defaults to embedded PGLite on disk (won't work on serverless platforms like Vercel/CF).
  const flamecast = new Flamecast({
    storage: await createPsqlStorage(),
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
