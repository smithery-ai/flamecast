import { pathToFileURL } from "node:url";
import { Flamecast } from "@acp/flamecast";

export async function startServer() {
  const flamecast = new Flamecast();
  await flamecast.listen(3001);
  return flamecast;
}

export async function main() {
  return startServer();
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
