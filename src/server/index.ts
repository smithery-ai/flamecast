import { Flamecast } from "../flamecast/index.js";

const flamecast = new Flamecast();
const server = await flamecast.listen(3001);

async function shutdown() {
  console.log("\nShutting down...");
  await flamecast.shutdown();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
