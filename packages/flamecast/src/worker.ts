import { Flamecast } from "./flamecast/index.js";
import { createServerApp } from "./server/app.js";

const flamecast = new Flamecast({
  storage: "memory",
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
