// Provider + ACP hooks (from @durable-acp/server/react)
export {
  FlamecastProvider,
  useAcpSession,
  useCollections,
  useDb,
  useEndpoints,
  type DurableAcpProviderProps,
  type UseSessionOptions,
  type SessionState,
} from "./provider.js";

// Session hooks (backed by durable stream collections)
export { useFlamecastSession } from "./hooks/use-flamecast-session.js";
export { useSessions } from "./hooks/use-sessions.js";
export { useSession } from "./hooks/use-session.js";
export { useSessionState } from "./hooks/use-session-state.js";
export { useTerminal } from "./hooks/use-terminal.js";
export type { TerminalSession } from "./hooks/use-terminal.js";

// Utilities
export { useIsMobile } from "./hooks/use-mobile.js";
