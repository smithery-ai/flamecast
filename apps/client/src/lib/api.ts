import { createFlamecastClient } from "@flamecast/sdk/client";

const DEFAULT_HOSTED_API_URL = "https://flamecast-backend.smithery.workers.dev/api";

export function resolveApiBaseUrl(env: { VITE_API_URL?: string; DEV?: boolean }): string {
  if (env.VITE_API_URL) return env.VITE_API_URL;
  return env.DEV ? "/api" : DEFAULT_HOSTED_API_URL;
}

const client = createFlamecastClient({
  baseUrl: resolveApiBaseUrl(import.meta.env),
});

export const {
  createSession,
  fetchAgentTemplates,
  fetchRuntimeFilePreview,
  fetchRuntimeFileSystem,
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
