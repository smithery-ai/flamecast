import {
  ChatSdkConnector,
  extractMessageText,
  type ChatSdkClient,
  type ChatSdkConnectorOptions,
  type ChatSdkMessage,
} from "./connector.js";
import {
  SqlThreadAgentBindingStore,
  type ChatSdkThread,
  type CreateSqlThreadAgentBindingStoreOptions,
  type SqlThreadAgentBindingDatabase,
  type ThreadAgentBinding,
} from "./bindings.js";
import {
  createFlamecastAgentClient,
  createConnectorMcpServer,
  type FlamecastAgent,
  type FlamecastAgentClient,
  type FlamecastCreateAgentBody,
  type FlamecastPromptResult,
  type FlamecastSpawn,
} from "./flamecast.js";

// Keep the barrel visible to V8 coverage so package-level coverage reporting stays honest.
const pluginEntrypoint = {
  ChatSdkConnector,
  SqlThreadAgentBindingStore,
  createFlamecastAgentClient,
  createConnectorMcpServer,
  extractMessageText,
};
void pluginEntrypoint;

export {
  ChatSdkConnector,
  extractMessageText,
  createFlamecastAgentClient,
  SqlThreadAgentBindingStore,
  createConnectorMcpServer,
  type ChatSdkClient,
  type ChatSdkConnectorOptions,
  type ChatSdkMessage,
  type ChatSdkThread,
  type CreateSqlThreadAgentBindingStoreOptions,
  type FlamecastAgent,
  type FlamecastAgentClient,
  type FlamecastCreateAgentBody,
  type FlamecastPromptResult,
  type FlamecastSpawn,
  type SqlThreadAgentBindingDatabase,
  type ThreadAgentBinding,
};
