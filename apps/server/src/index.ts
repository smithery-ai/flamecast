import { pathToFileURL } from "node:url";
import { Flamecast } from "@flamecast/sdk";
import { createServerStorage } from "./storage/index.js";

export async function main() {
  const flamecast = new Flamecast({
    storage: await createServerStorage(),
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
