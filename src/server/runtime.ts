import { Flamecast } from "@/flamecast/index.js";
import { IntegrationBroker, createIntegrationProxyRoutes } from "./integrations/broker.js";
import { createPlatformBridge } from "./integrations/chat.js";
import { getIntegrationPool } from "./integrations/db.js";
import { createLinearAgentRoutes } from "./integrations/linear-agent.js";
import { ConversationRuntime } from "./integrations/runtime.js";
import { IntegrationStore } from "./integrations/store.js";
import { getIntegrationConfig } from "./integrations/config.js";

export const flamecast = new Flamecast();

const integrationStore = new IntegrationStore(getIntegrationConfig().brokerEncryptionKey);
const integrationBroker = new IntegrationBroker(integrationStore);
const conversationRuntime = new ConversationRuntime(flamecast, integrationBroker, integrationStore);
const platformBridge = createPlatformBridge({
  pool: getIntegrationPool(),
  runtime: conversationRuntime,
  store: integrationStore,
});
const linearAgentRoutes = createLinearAgentRoutes(conversationRuntime);
const proxyRoutes = createIntegrationProxyRoutes(integrationBroker);

export const integrations = {
  broker: integrationBroker,
  conversationRuntime,
  linearAgentRoutes,
  platformBridge,
  proxyRoutes,
  store: integrationStore,
};
