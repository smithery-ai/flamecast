import { createFlamecastClient } from "../api.js";

const client = createFlamecastClient({ baseUrl: "/api" });

export const {
  createSession,
  fetchAgentTemplates,
  fetchRuntimes,
  fetchSession,
  fetchSessions,
  registerAgentTemplate,
  startRuntime,
  stopRuntime,
  terminateSession,
} = client;
