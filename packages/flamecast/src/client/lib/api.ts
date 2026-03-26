import { createFlamecastClient } from "../api.js";

const client = createFlamecastClient({ baseUrl: "/api" });

export const {
  createSession,
  fetchAgentTemplates,
  fetchRuntimes,
  fetchSession,
  fetchSessions,
  pauseRuntime,
  registerAgentTemplate,
  startRuntime,
  stopRuntime,
  terminateSession,
} = client;
