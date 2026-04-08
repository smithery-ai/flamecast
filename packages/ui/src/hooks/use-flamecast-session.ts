/**
 * useFlamecastSession — backwards-compatible wrapper around useAcpSession.
 *
 * The websocketUrl parameter is ignored — ACP connection is managed by
 * the DurableAcpProvider (from @durable-acp/server/react).
 */

export { useAcpSession as useFlamecastSession } from "../provider.js";
export type { SessionState as FlamecastSessionState } from "../provider.js";
