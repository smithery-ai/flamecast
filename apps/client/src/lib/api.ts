import { createFlamecastClient } from "@flamecast/sdk/client";

const client = createFlamecastClient({ baseUrl: "/api" });

export const {
  createSession,
  execOnRuntime,
  fetchAgentTemplates,
  fetchRuntimes,
  fetchRuntimeFile,
  fetchRuntimeFsSnapshot,
  fetchSession,
  fetchSessions,
  pauseRuntime,
  registerAgentTemplate,
  updateAgentTemplate,
  startRuntime,
  stopRuntime,
  terminateSession,
} = client;
