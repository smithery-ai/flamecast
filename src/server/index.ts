import { pathToFileURL } from "node:url";
import { Flamecast } from "../flamecast/index.js";

export function createShutdownHandler(flamecast: Flamecast, server: { close: () => void }) {
  return async function shutdown() {
    console.log("\nShutting down...");
    await flamecast.shutdown();
    server.close();
    process.exit(0);
  };
}

export async function startServer() {
  const flamecast = new Flamecast();
  const server = await flamecast.listen(3001);
  const shutdown = createShutdownHandler(flamecast, server);

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { flamecast, server, shutdown };
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
