import { Flamecast } from "./flamecast/index.js";
import { MemoryFlamecastStateManager } from "./flamecast/state-managers/memory/index.js";
import { getBuiltinAgentPresets } from "./flamecast/presets.js";
import { createServerApp } from "./server/app.js";

const flamecast = new Flamecast({
  stateManager: new MemoryFlamecastStateManager(),
  provisioner: async () => {
    throw new Error("Agent provisioning not available in Worker — configure a remote provisioner");
  },
  presets: getBuiltinAgentPresets(),
});

export default createServerApp(flamecast);
