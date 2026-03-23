import { createFlamecastClient } from "../api.js";
import { SessionLogSchema, type SessionLog } from "../../shared/session";

const client = createFlamecastClient({ baseUrl: "/api" });

export const {
  createSession,
  fetchAgentTemplates,
  fetchFilePreview,
  fetchSession,
  fetchSessions,
  registerAgentTemplate,
  respondToPermission,
  sendPrompt,
  terminateSession,
} = client;

export function subscribeToSessionEvents(
  sessionId: string,
  onEvent: (event: SessionLog) => void,
  onError?: (error: Event) => void,
): () => void {
  const eventSource = new EventSource(`/api/agents/${encodeURIComponent(sessionId)}/events`);

  eventSource.onmessage = (event) => {
    try {
      const result = SessionLogSchema.safeParse(JSON.parse(event.data));
      if (result.success) {
        onEvent(result.data);
      }
    } catch {
      // Skip malformed events.
    }
  };

  if (onError) {
    eventSource.onerror = onError;
  }

  return () => {
    eventSource.close();
  };
}
