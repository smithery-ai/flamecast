import { Flamecast } from "./flamecast/index.js";
import { MemoryFlamecastStorage } from "./flamecast/storage/memory/index.js";
import { createServerApp } from "./server/app.js";

const flamecast = new Flamecast({
  storage: new MemoryFlamecastStorage(),
  runtimeProviders: {
    local: {
      async start() {
        throw new Error(
          "Agent runtime provisioning not available in Worker — configure a remote runtime provider",
        );
      },
    },
    docker: {
      async start() {
        throw new Error(
          "Agent runtime provisioning not available in Worker — configure a remote runtime provider",
        );
      },
    },
  },
});

export default createServerApp(flamecast);
