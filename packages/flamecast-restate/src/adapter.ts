/**
 * AgentAdapter interface + types for ACP agent orchestration.
 *
 * Defines the unified interface that abstracts Zed ACP (stdio JSON-RPC)
 * and IBM ACP (REST HTTP) protocols. The VO calls the adapter without
 * knowing which protocol is underneath.
 *
 * Reference: docs/sdd-durable-acp-bridge.md §2.1-2.2
 */

// ─── Agent Events (streaming + control-plane) ─────────────────────────────

export type AgentEvent =
  | { type: "text"; text: string; role: "assistant" | "thinking" }
  | {
      type: "tool";
      toolCallId: string;
      title: string;
      status: "pending" | "running" | "completed" | "failed";
      input?: unknown;
      output?: unknown;
    }
  | { type: "pause"; request: unknown }
  | {
      type: "complete";
      reason: "end_turn" | "cancelled" | "failed" | "max_tokens";
      output?: AgentMessage[];
    }
  | { type: "error"; code: string; message: string };

// ─── Messages ──────────────────────────────────────────────────────────────

export interface AgentMessage {
  role: "user" | "assistant";
  parts: Array<{
    contentType: string;
    content?: string;
    contentUrl?: string;
  }>;
}

// ─── Agent Info ────────────────────────────────────────────────────────────

export interface AgentInfo {
  name: string;
  description?: string;
  capabilities?: Record<string, unknown>;
}

// ─── Session Handle (stored in VO state) ───────────────────────────────────

export interface SessionHandle {
  sessionId: string;
  protocol: "zed" | "ibm";
  agent: AgentInfo;
  connection: {
    url?: string; // HTTP URL for IBM / containerized Zed agents
    pid?: number; // Local process PID (non-durable — dies on restart)
    containerId?: string; // Docker container ID (may survive restart)
    sandboxId?: string; // E2B sandbox ID (may survive restart)
  };
}

// ─── Start Config ──────────────────────────────────────────────────────────

export interface AgentCallbacks {
  onPermissionRequest?: (request: unknown) => Promise<unknown>;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentStartConfig {
  agent: string; // Binary path (Zed) or base URL + agent name (IBM)
  cwd?: string; // Working directory
  sessionId?: string; // Explicit session ID
  env?: Record<string, string>;
  callbacks?: AgentCallbacks;
}

// ─── Prompt Result (journaled by ctx.run()) ────────────────────────────────

export interface PromptResult {
  status: "completed" | "awaiting" | "failed" | "cancelled";
  output?: AgentMessage[];
  awaitRequest?: unknown; // present when status === "awaiting"
  runId?: string; // for resumeSync / client SSE subscription
  error?: string; // present when status === "failed"
}

// ─── Config Options (ACP session configuration) ────────────────────────────

export interface ConfigOption {
  id: string;
  label: string;
  type: "string" | "enum";
  value: string;
  options?: string[];
}

// ─── Webhook Config ────────────────────────────────────────────────────────

export interface WebhookConfig {
  url: string;
  events: string[];
  secret?: string;
}

// ─── Session Metadata (stored in VO state as "meta") ───────────────────────

export interface SessionMeta {
  sessionId: string;
  protocol: "zed" | "ibm";
  agent: AgentInfo;
  status: "active" | "running" | "paused" | "completed" | "failed" | "killed";
  startedAt: string;
  lastUpdatedAt: string;
}

// ─── Adapter Interface ─────────────────────────────────────────────────────

/**
 * Unified adapter interface for ACP agent communication.
 *
 * Methods fall into three categories:
 * - Core lifecycle: start, cancel, close
 * - Streaming (API layer, not journaled): prompt, resume
 * - Sync (VO handler, inside ctx.run(), journaled): promptSync, resumeSync
 * - Config (journaled via ctx.run() directly): getConfigOptions, setConfigOption
 *
 * `steer` is NOT an adapter method — it's a VO handler that composes
 * cancel() → setConfigOption() → promptSync() as separate ctx.run() steps.
 */
export interface AgentAdapter {
  // --- Core lifecycle ---
  start(config: AgentStartConfig): Promise<SessionHandle>;
  cancel(session: SessionHandle): Promise<void>;
  close(session: SessionHandle): Promise<void>;

  // --- Streaming (API layer / client-direct, not journaled) ---
  prompt(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): AsyncIterable<AgentEvent>;
  resume(
    session: SessionHandle,
    payload: unknown,
  ): AsyncIterable<AgentEvent>;

  // --- Sync (VO handler, inside ctx.run(), journaled) ---
  promptSync(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): Promise<PromptResult>;
  resumeSync(
    session: SessionHandle,
    runId: string,
    payload: unknown,
  ): Promise<PromptResult>;

  // --- Config (journaled via ctx.run() directly) ---
  getConfigOptions(session: SessionHandle): Promise<ConfigOption[]>;
  setConfigOption(
    session: SessionHandle,
    configId: string,
    value: string,
  ): Promise<ConfigOption[]>;
}

// ─── IBM-specific: createRun (used by IbmAgentSession VO separately) ──────

/**
 * Extended interface for IBM ACP adapters.
 * The VO calls createRun and awaitRun as separate ctx.run() steps
 * so the runId is visible immediately for client SSE subscription.
 */
export interface IbmAcpAdapterInterface extends AgentAdapter {
  createRun(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): Promise<{ runId: string }>;
}
