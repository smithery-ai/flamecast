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

// Terminal (backed by durable stream + REST kill)
export { useTerminal } from "./hooks/use-terminal.js";
export type { TerminalSession } from "./hooks/use-terminal.js";

// Filesystem (backed by REST API)
export { useSessionFilesystem } from "./hooks/use-session-filesystem.js";

// Session lifecycle
export { useTerminateSession } from "./hooks/use-terminate-session.js";
export { useCreateSession } from "./hooks/use-create-session.js";

// Agent templates (stub — pending agents.toml REST endpoint)
export { useAgentTemplates } from "./hooks/use-agent-templates.js";

// Utilities
export { useIsMobile } from "./hooks/use-mobile.js";
