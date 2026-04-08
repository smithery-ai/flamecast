/**
 * useCreateSession — create a new agent session.
 *
 * With durable-acp-rs, connecting via the /acp WebSocket creates a session
 * automatically (the useSession/useAcpSession hook handles this). This hook
 * is a no-op wrapper for backwards compatibility.
 */

export function useCreateSession() {
  return {
    createSession: async (_agentId: string) => {
      // Session creation happens automatically when useAcpSession connects.
      // This hook exists for API compatibility with the old Flamecast SDK.
    },
    isLoading: false,
    error: null,
  };
}
