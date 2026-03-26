import { createFlamecastClient } from "../api.js";

const client = createFlamecastClient({ baseUrl: "/api" });

export const {
  // Agent templates
  fetchAgentTemplates,
  registerAgentTemplate,
  // Sessions
  createSession,
  fetchSession,
  fetchSessions,
  terminateSession,
  // Prompts
  promptSession,
  // Permissions
  resolvePermission,
  // Queue
  fetchQueue,
  cancelQueueItem,
  clearQueue,
  reorderQueue,
  pauseQueue,
  resumeQueue,
} = client;
