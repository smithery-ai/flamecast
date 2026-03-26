import { createFlamecastClient } from "@flamecast/sdk/client";

const client = createFlamecastClient({ baseUrl: "/api" });

export const {
  createSession,
  fetchAgentTemplates,
  fetchRuntimes,
  fetchSession,
  fetchSessions,
  terminateSession,
} = client;
