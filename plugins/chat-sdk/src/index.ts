import {
  ChatSdkConnector,
  extractMessageText,
  type ChatSdkConnectorOptions,
} from "./connector.js";

// Keep the barrel visible to V8 coverage so package-level coverage reporting stays honest.
const pluginEntrypoint = {
  ChatSdkConnector,
  extractMessageText,
};
void pluginEntrypoint;

export {
  ChatSdkConnector,
  extractMessageText,
  type ChatSdkConnectorOptions,
};

export type { AppType } from "@acp/flamecast/api";
export type { Chat, Message, Thread } from "chat";
export type {
  AgentSpawn,
  CreateSessionBody,
  Session,
  SessionLog,
} from "@acp/flamecast/shared/session";
