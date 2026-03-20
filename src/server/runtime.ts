import "dotenv/config";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Flamecast,
  MemoryFlamecastStateManager,
  createPsqlStateManager,
} from "@/flamecast/index.js";
import { loadServerConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createDbState } from "./integrations/db-state.js";
import { ChatGateway } from "./integrations/chat-gateway.js";

const serverConfig = await loadServerConfig();
const database = await createDatabase();
const stateManager =
  serverConfig.stateManager === "memory"
    ? new MemoryFlamecastStateManager()
    : createPsqlStateManager(database.db);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..", "..");
const chatActionMcpPath = resolve(projectRoot, "src/flamecast/chat-action-mcp.ts");
const tsxExecutable = resolve(
  projectRoot,
  "node_modules/.bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

function normalizeInternalApiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  return (trimmed || "http://127.0.0.1:3001/api/internal").replace(/\/$/, "");
}

export const internalApiToken = process.env.FLAMECAST_INTERNAL_API_TOKEN?.trim() || randomUUID();
export const internalApiBaseUrl = normalizeInternalApiBaseUrl(
  process.env.FLAMECAST_INTERNAL_API_BASE_URL,
);

let chatGatewayRef: ChatGateway | null = null;

export const flamecast = new Flamecast({
  executeChatAction: async (input) => {
    if (!chatGatewayRef) {
      throw new Error("Chat gateway is not initialized");
    }
    return chatGatewayRef.executeAction(input);
  },
  sessionMcpServers: (connectionId) => [
    {
      args: [chatActionMcpPath],
      command: tsxExecutable,
      env: [
        { name: "FLAMECAST_CONNECTION_ID", value: connectionId },
        { name: "FLAMECAST_INTERNAL_API_BASE_URL", value: internalApiBaseUrl },
        { name: "FLAMECAST_INTERNAL_API_TOKEN", value: internalApiToken },
      ],
      name: "flamecast-chat-actions",
    },
  ],
  stateManager,
});

export const chatGateway = new ChatGateway(flamecast, database.db, createDbState(database.db));

chatGatewayRef = chatGateway;
