import { pathToFileURL } from "node:url";
import { Flamecast } from "@acp/flamecast";

export async function main() {
  const flamecast = new Flamecast();
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
  // Test
  void main();
}
