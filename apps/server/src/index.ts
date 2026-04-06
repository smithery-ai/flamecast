import { listen } from "@flamecast/sdk";
import flamecast from "../flamecast.config.js";

await flamecast.init();

listen(flamecast, { port: 3001, cors: true }, (info) => {
  console.log(`Flamecast running on http://localhost:${info.port}`);
});

// Graceful close: tear down in-process resources but leave sessions alive so
// they can be recovered on the next startup via recoverSessions().
process.on("SIGINT", () => {
  flamecast.close().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  flamecast.close().then(() => process.exit(0));
});
