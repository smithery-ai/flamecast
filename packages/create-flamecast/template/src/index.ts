import { listen } from "@flamecast/sdk";
import flamecast from "../flamecast.config.js";

await flamecast.init();

listen(flamecast, { port: 3001 }, (info) => {
  console.log(`Flamecast running on http://localhost:${info.port}`);
});

process.on("SIGINT", () => {
  flamecast.close().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  flamecast.close().then(() => process.exit(0));
});
