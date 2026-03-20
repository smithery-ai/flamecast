import "dotenv/config";
import {
  Flamecast,
  MemoryFlamecastStateManager,
  createPsqlStateManager,
} from "@/flamecast/index.js";
import { loadServerConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createPGliteState } from "./integrations/pglite-state.js";
import { SlackInstaller } from "./integrations/slack.js";

const serverConfig = await loadServerConfig();
const stateManager =
  serverConfig.stateManager === "memory"
    ? new MemoryFlamecastStateManager()
    : createPsqlStateManager((await createDatabase()).db);

export const flamecast = new Flamecast({ stateManager });
export const slackInstaller = new SlackInstaller(flamecast, createPGliteState());
