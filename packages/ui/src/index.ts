// Provider
export { FlamecastProvider, useFlamecastClient } from "./provider.js";

// Query hooks
export { useAgentTemplates } from "./hooks/use-agent-templates.js";
export { useRuntimes } from "./hooks/use-runtimes.js";
export { useSessions } from "./hooks/use-sessions.js";
export { useSession } from "./hooks/use-session.js";
export { useRuntimeFileSystem } from "./hooks/use-runtime-filesystem.js";

// Mutation hooks
export { useCreateSession } from "./hooks/use-create-session.js";
export { useRegisterAgentTemplate } from "./hooks/use-register-agent-template.js";
export { useUpdateAgentTemplate } from "./hooks/use-update-agent-template.js";
export {
  useStartRuntime,
  useStopRuntime,
  usePauseRuntime,
  useStartRuntimeWithOptimisticUpdate,
} from "./hooks/use-runtime-mutations.js";
export { useTerminateSession } from "./hooks/use-terminate-session.js";

// WebSocket hooks
export { useFlamecastSession } from "./hooks/use-flamecast-session.js";
export type { ConnectionState } from "./hooks/use-flamecast-session.js";
export { useSessionState } from "./hooks/use-session-state.js";
export { useTerminal } from "./hooks/use-terminal.js";
export type { TerminalSession } from "./hooks/use-terminal.js";

// Utilities
export { useIsMobile } from "./hooks/use-mobile.js";
export { sessionLogsToSegments } from "./lib/logs-markdown.js";
export type { SessionLogMarkdownSegment } from "./lib/logs-markdown.js";
export { resolveRuntimeSelection } from "./lib/runtime-selection.js";
export { reduceRuntimeTerminalSessions } from "./lib/runtime-terminal-state.js";
export type { RuntimeTerminalSession } from "./lib/runtime-terminal-state.js";
export { createWsMessageDedupeState, rememberWsMessage } from "./lib/ws-message-dedupe.js";
export type { WsMessageDedupeState } from "./lib/ws-message-dedupe.js";
