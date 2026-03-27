import { createFlamecastClient } from "@flamecast/sdk/client";

const client = createFlamecastClient({ baseUrl: "/api" });

export const {
  createSession,
  fetchAgentTemplates,
  fetchRuntimes,
  fetchSessionFilePreview,
  fetchSessionFileSystem,
  fetchSession,
  fetchSessions,
  pauseRuntime,
  registerAgentTemplate,
  updateAgentTemplate,
  startRuntime,
  stopRuntime,
  terminateSession,
} = client;
