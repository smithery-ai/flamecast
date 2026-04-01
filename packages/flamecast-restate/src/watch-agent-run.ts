/**
 * API layer SSE listener for IBM ACP agent runs.
 *
 * Watches an IBM ACP agent's SSE event stream and:
 * 1. Forwards message.part tokens to Restate pubsub (client UI)
 * 2. Resolves the VO's awakeable on terminal state (run.completed, run.awaiting, run.failed)
 *
 * Runs OUTSIDE Restate — no ctx needed. Triggered by the API layer when
 * IbmAgentSession publishes run.started.
 *
 * Reference: docs/sdd-durable-acp-bridge.md §5.2
 */

import * as clients from "@restatedev/restate-sdk-clients";
import { pubsubObject } from "./session-object.js";
import type { PromptResult, AgentMessage } from "./adapter.js";

// ─── SSE Event Types (IBM ACP agent stream) ────────────────────────────────

interface AgentSSEEvent {
  type: string;
  data: unknown;
}

interface RunTerminalData {
  status: string;
  output?: AgentMessage[];
  await_request?: unknown;
  error?: string;
}

// ─── SSE Parser ────────────────────────────────────────────────────────────

async function* agentSSE(url: string, signal?: AbortSignal): AsyncIterable<AgentSSEEvent> {
  const res = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal,
  });

  if (!res.ok) {
    throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
  }

  if (!res.body) {
    throw new Error("SSE response has no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  let data = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data += line.slice(5).trim();
        } else if (line === "") {
          if (data) {
            try {
              yield { type: eventType || "message", data: JSON.parse(data) };
            } catch {
              yield { type: eventType || "message", data };
            }
            eventType = "";
            data = "";
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Pubsub publisher (outside Restate, uses ingress client) ───────────────

interface PubsubPublisher {
  publish(topic: string, event: unknown): Promise<void>;
}

function createPubsubPublisher(restateUrl: string): PubsubPublisher {
  const ingress = clients.connect({ url: restateUrl });
  return {
    async publish(topic: string, event: unknown): Promise<void> {
      // Send to the pubsub virtual object's publish handler via typed client
      ingress
        .objectSendClient(pubsubObject, topic)
        .publish(event);
    },
  };
}

// ─── Terminal state helpers ────────────────────────────────────────────────

const TERMINAL_EVENTS = new Set(["run.completed", "run.awaiting", "run.failed"]);

function toPromptResult(type: string, data: RunTerminalData): PromptResult {
  switch (type) {
    case "run.completed":
      return { status: "completed", output: data.output };
    case "run.awaiting":
      return { status: "awaiting", awaitRequest: data.await_request };
    case "run.failed":
      return { status: "failed", error: data.error ?? "Agent run failed" };
    default:
      return { status: "failed", error: `Unexpected terminal event: ${type}` };
  }
}

// ─── Main watcher ──────────────────────────────────────────────────────────

export interface WatchAgentRunOptions {
  /** Base URL of the IBM ACP agent (e.g. http://localhost:8000/agents/echo) */
  agentUrl: string;
  /** Run ID to watch */
  runId: string;
  /** Restate awakeable ID to resolve on terminal state */
  awakeableId: string;
  /** Pubsub topic for event forwarding (e.g. session:<sessionId>) */
  topic: string;
  /** Restate ingress URL (default: http://localhost:18080) */
  restateUrl?: string;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

/**
 * Watch an IBM ACP agent run's SSE stream.
 *
 * - Forwards message.part tokens to Restate pubsub for client UI.
 * - Resolves the VO's awakeable when the run reaches a terminal state.
 * - Runs outside Restate (in the API layer, e.g. with waitUntil).
 */
export async function watchAgentRun(options: WatchAgentRunOptions): Promise<void> {
  const {
    agentUrl,
    runId,
    awakeableId,
    topic,
    restateUrl = "http://localhost:18080",
    signal,
  } = options;

  const pubsub = createPubsubPublisher(restateUrl);
  const ingress = clients.connect({ url: restateUrl });

  const sseUrl = `${agentUrl}/runs/${runId}/events`;

  try {
    for await (const event of agentSSE(sseUrl, signal)) {
      // Forward tokens to pubsub for client UI
      if (event.type === "message.part") {
        await pubsub.publish(topic, event);
      }

      // Resolve awakeable on terminal state — resumes the VO handler
      if (TERMINAL_EVENTS.has(event.type)) {
        const result = toPromptResult(event.type, event.data as RunTerminalData);
        await ingress.resolveAwakeable(awakeableId, result);
        break;
      }
    }
  } catch (error) {
    // SSE connection failed — resolve awakeable with failure so VO doesn't hang
    const errorMessage = error instanceof Error ? error.message : String(error);
    await ingress.resolveAwakeable<PromptResult>(awakeableId, {
      status: "failed",
      error: `SSE listener error: ${errorMessage}`,
    });
  }
}
