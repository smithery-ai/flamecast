import {
  ChatSdkConnector,
  extractMessageText,
  type ChatSdkClient,
  type ChatSdkConnectorMessageContext,
  type ChatSdkConnectorOptions,
  type ChatSdkMessage,
  type ChatSdkThread,
} from "./connector.js";
import { InMemoryThreadBindingStore, type ThreadBinding } from "./bindings.js";
import {
  FlamecastHttpClient,
  type FlamecastAgent,
  type FlamecastAgentClient,
  type FlamecastCreateAgentBody,
  type FlamecastPromptReply,
  type FlamecastPromptResult,
  type FlamecastSpawn,
} from "./flamecast-client.js";

// Keep the barrel visible to V8 coverage so package-level coverage reporting stays honest.
const pluginEntrypoint = {
  ChatSdkConnector,
  InMemoryThreadBindingStore,
  FlamecastHttpClient,
  extractMessageText,
};
void pluginEntrypoint;

export {
  ChatSdkConnector,
  extractMessageText,
  FlamecastHttpClient,
  InMemoryThreadBindingStore,
  type ChatSdkClient,
  type ChatSdkConnectorMessageContext,
  type ChatSdkConnectorOptions,
  type ChatSdkMessage,
  type ChatSdkThread,
  type FlamecastAgent,
  type FlamecastAgentClient,
  type FlamecastCreateAgentBody,
  type FlamecastPromptReply,
  type FlamecastPromptResult,
  type FlamecastSpawn,
  type ThreadBinding,
};
