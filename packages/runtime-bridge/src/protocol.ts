/**
 * Bridge HTTP protocol — the contract between the control plane (SessionManager)
 * and the data plane (runtime-bridge process).
 *
 * Each bridge instance handles exactly one session (D1: one bridge per session).
 */

// ---- POST /start ----

export interface BridgeStartRequest {
  /** Agent command to spawn (e.g. "node", "pnpm") */
  command: string;
  /** Arguments for the agent command */
  args: string[];
  /** Working directory for the agent */
  workspace: string;
  /** Optional setup command to run before spawning the agent (SMI-1677) */
  setup?: string;
}

export interface BridgeStartResponse {
  /** ACP session ID assigned by the agent */
  sessionId: string;
  /** WebSocket URL for the browser to connect to */
  websocketUrl: string;
  /** Port the bridge is listening on */
  port: number;
}

// ---- POST /terminate ----
// Request: empty body
// Response: 200 OK (empty)

// ---- GET /health ----

export interface BridgeHealthResponse {
  status: "idle" | "running";
  sessionId?: string;
}
