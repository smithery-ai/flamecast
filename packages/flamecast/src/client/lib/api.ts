import { createFlamecastClient } from "../api.js";

const client = createFlamecastClient({
  baseUrl: import.meta.env.VITE_FLAMECAST_API_URL ?? "/api",
});

export const {
  createSession,
  fetchAgentTemplates,
  fetchSession,
  fetchSessions,
  registerAgentTemplate,
  terminateSession,
} = client;
