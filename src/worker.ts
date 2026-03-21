import { Hono } from "hono";
import { Flamecast } from "./flamecast/index.js";
import { createApi } from "./flamecast/api.js";
import { MemoryFlamecastStateManager } from "./flamecast/state-managers/memory/index.js";

const flamecast = new Flamecast({
  stateManager: new MemoryFlamecastStateManager(),
  provisioner: async () => {
    throw new Error("Agent provisioning not available in Worker — configure a remote provisioner");
  },
  presets: [
    { id: "example", label: "Example agent", spawn: { command: "npx", args: ["tsx", "src/flamecast/agent.ts"] } },
    { id: "codex", label: "Codex ACP", spawn: { command: "npx", args: ["@zed-industries/codex-acp"] } },
    { id: "codex-docker", label: "Codex ACP (Docker)", spawn: { command: "codex-acp", args: [] } },
  ],
});

const app = new Hono();
app.route("/api", createApi(flamecast));

export default app;
