import { createFlamecastClient } from "../api.js";

const client = createFlamecastClient({ baseUrl: "/api" });

export const {
  createSession,
  fetchAgentTemplates,
  fetchSession,
  fetchSessions,
  registerAgentTemplate,
  terminateSession,
} = client;
