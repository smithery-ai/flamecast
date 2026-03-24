/**
 * DataPlaneBinding — the uniform interface the SessionManager uses to
 * communicate with data plane instances (runtime-bridge processes).
 *
 * Two implementations exist, both returned by the FlamecastRuntime
 * Alchemy resource:
 *
 * LOCAL (alchemy dev):
 *   Bridge manager service — rewrites the request URL to include the
 *   sessionId in the path (/sessions/:sessionId/start), then forwards
 *   to the bridge manager HTTP server which routes to per-session
 *   child processes.
 *
 * DEPLOYED (alchemy deploy):
 *   CF Container binding (DurableObjectNamespace) — uses Durable Object-
 *   style routing: binding.idFromName(sessionId).get(id).fetch(request).
 *   Each sessionId maps to a dedicated container instance with affinity.
 *
 * The SessionManager never knows which implementation it's talking to.
 */
export interface DataPlaneBinding {
  fetchSession(sessionId: string, request: Request): Promise<Response>;
}

// ---- Bridge HTTP contract (mirrors runtime-bridge/src/protocol.ts) ----
// These types define the wire format for control plane → data plane communication.

export interface BridgeStartRequest {
  command: string;
  args: string[];
  workspace: string;
  /** Optional setup command to run before spawning the agent (SMI-1677) */
  setup?: string;
}

export interface BridgeStartResponse {
  sessionId: string;
  websocketUrl: string;
  port: number;
}

export interface BridgeHealthResponse {
  status: "idle" | "running";
  sessionId?: string;
}
