// Provider
export { FlamecastProvider, useFlamecastClient } from "./provider.js";

// Query hooks
export { useAgentTemplates } from "./hooks/use-agent-templates.js";
export { useRuntimes } from "./hooks/use-runtimes.js";
export { useSessions } from "./hooks/use-sessions.js";
export { useSession } from "./hooks/use-session.js";
export { useRuntimeFileSystem } from "./hooks/use-runtime-filesystem.js";
export { useSessionFileSystem } from "./hooks/use-session-filesystem.js";
export {
  useRuntimeGitBranches,
  useRuntimeGitWorktrees,
  useCreateRuntimeGitWorktree,
} from "./hooks/use-runtime-git.js";

// Mutation hooks
export { useCreateSession } from "./hooks/use-create-session.js";
export { useRegisterAgentTemplate } from "./hooks/use-register-agent-template.js";
export { useUpdateAgentTemplate } from "./hooks/use-update-agent-template.js";
export {
  useStartRuntime,
  useStopRuntime,
  usePauseRuntime,
  useDeleteRuntime,
  useStartRuntimeWithOptimisticUpdate,
} from "./hooks/use-runtime-mutations.js";
export { useTerminateSession } from "./hooks/use-terminate-session.js";
export {
  useMessageQueue,
  useEnqueueMessage,
  useSendQueuedMessage,
  useRemoveQueuedMessage,
  useClearMessageQueue,
} from "./hooks/use-message-queue.js";

// WebSocket hooks
export { useRuntimeWebSocket } from "./hooks/use-runtime-websocket.js";
export type { ConnectionState, RuntimeWebSocketHandle } from "./hooks/use-runtime-websocket.js";
export { useFlamecastSession } from "./hooks/use-flamecast-session.js";
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
