/**
 * IBM ACP (Agent Communication Protocol) adapter — REST over HTTP.
 *
 * Implements the IbmAcpAdapterInterface for communicating with IBM ACP agents
 * via their REST API. The VO uses createRun + awakeable pattern for durable
 * orchestration; promptSync/awaitRun is provided for simple callers.
 *
 * Reference: docs/sdd-durable-acp-bridge.md §2.3
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentStartConfig,
  ConfigOption,
  IbmAcpAdapterInterface,
  PromptResult,
  SessionHandle,
} from "./adapter.js";

export class IbmAcpAdapter implements IbmAcpAdapterInterface {
  // --- Core lifecycle ---

  async start(config: AgentStartConfig): Promise<SessionHandle> {
    // config.agent is the base URL + agent name, e.g. "http://localhost:8000/agents/echo"
    // Parse baseUrl (origin) and agentName from config.agent
    const url = new URL(config.agent);
    const agentName = url.pathname.split("/").pop()!;
    const baseUrl = url.origin;

    // GET /agents/{name} to verify agent exists
    const res = await fetch(config.agent);
    if (!res.ok)
      throw new Error(`Agent not found: ${res.status} ${res.statusText}`);
    const agentInfo = (await res.json()) as {
      name: string;
      description?: string;
    };

    return {
      sessionId: config.sessionId ?? crypto.randomUUID(),
      protocol: "ibm",
      agent: {
        name: agentInfo.name ?? agentName,
        description: agentInfo.description,
      },
      connection: { url: baseUrl },
    };
  }

  async cancel(_session: SessionHandle): Promise<void> {
    // POST /runs/{runId}/cancel — requires runId context.
    // The VO stores pending_run with runId and handles cancellation
    // via the run state. This is a no-op placeholder at the adapter level.
  }

  async close(_session: SessionHandle): Promise<void> {
    // IBM ACP is stateless HTTP — no-op per SDD §2.3
  }

  // --- IBM-specific: split create + await for VO awakeable pattern ---

  async createRun(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): Promise<{ runId: string }> {
    // POST /runs { agent_name, input, mode: "async" }
    const baseUrl = session.connection.url!;
    const messages =
      typeof input === "string"
        ? [
            {
              role: "user" as const,
              parts: [{ contentType: "text/plain", content: input }],
            },
          ]
        : input;

    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_name: session.agent.name,
        input: messages,
        mode: "async",
      }),
    });

    if (!res.ok)
      throw new Error(`Create run failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { run_id: string };
    return { runId: data.run_id };
  }

  // --- Sync (VO handler path, journaled) ---

  async promptSync(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): Promise<PromptResult> {
    // For simple callers: createRun + poll until terminal.
    // The VO uses createRun + awakeable instead for durability.
    const { runId } = await this.createRun(session, input);
    return this.awaitRun(session, runId);
  }

  async resumeSync(
    session: SessionHandle,
    runId: string,
    payload: unknown,
  ): Promise<PromptResult> {
    // POST /runs/{id} { await_resume: payload, mode: "async" }
    const baseUrl = session.connection.url!;
    const res = await fetch(`${baseUrl}/runs/${runId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        await_resume: payload,
        mode: "async",
      }),
    });
    if (!res.ok)
      throw new Error(`Resume run failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { run_id: string };
    return this.awaitRun(session, data.run_id ?? runId);
  }

  // --- Streaming (API layer, not journaled) ---

  async *prompt(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): AsyncGenerator<AgentEvent> {
    // POST /runs { mode: "stream" } → SSE events
    const baseUrl = session.connection.url!;
    const messages =
      typeof input === "string"
        ? [
            {
              role: "user" as const,
              parts: [{ contentType: "text/plain", content: input }],
            },
          ]
        : input;

    const res = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        agent_name: session.agent.name,
        input: messages,
        mode: "stream",
      }),
    });

    if (!res.ok)
      throw new Error(`Stream run failed: ${res.status}`);
    yield* this.parseSSE(res);
  }

  async *resume(
    _session: SessionHandle,
    _payload: unknown,
  ): AsyncGenerator<AgentEvent> {
    // POST /runs/{id} { await_resume, mode: "stream" }
    // Streaming resume requires runId context from the caller.
    yield {
      type: "error",
      code: "NOT_IMPLEMENTED",
      message: "Streaming resume requires runId context",
    };
  }

  // --- Config ---

  async getConfigOptions(_session: SessionHandle): Promise<ConfigOption[]> {
    // IBM ACP agents may not support config options — return empty
    return [];
  }

  async setConfigOption(
    _session: SessionHandle,
    _configId: string,
    _value: string,
  ): Promise<ConfigOption[]> {
    return [];
  }

  // --- Internal helpers ---

  private async awaitRun(
    session: SessionHandle,
    runId: string,
  ): Promise<PromptResult> {
    // Poll GET /runs/{runId} until terminal state
    const baseUrl = session.connection.url!;
    const maxAttempts = 600; // 10 minutes at 1s intervals
    for (let i = 0; i < maxAttempts; i++) {
      const res = await fetch(`${baseUrl}/runs/${runId}`);
      if (!res.ok) throw new Error(`Get run failed: ${res.status}`);
      const run = (await res.json()) as {
        status: string;
        output?: AgentMessage[];
        await_request?: unknown;
        error?: string;
      };

      if (run.status === "completed") {
        return { status: "completed", output: run.output, runId };
      }
      if (run.status === "awaiting") {
        return { status: "awaiting", awaitRequest: run.await_request, runId };
      }
      if (run.status === "failed") {
        return { status: "failed", error: run.error, runId };
      }
      if (run.status === "cancelled") {
        return { status: "cancelled", runId };
      }

      // Still running — wait and retry
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { status: "failed", error: "Timed out waiting for run", runId };
  }

  private async *parseSSE(res: Response): AsyncGenerator<AgentEvent> {
    if (!res.body) return;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        let eventType = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            data += line.slice(5).trim();
          } else if (line === "") {
            if (data) {
              const event = this.mapSSEEvent(eventType, data);
              if (event) yield event;
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

  /**
   * Map an SSE event to an AgentEvent.
   *
   * IBM ACP servers may use either:
   * - Standard SSE: `event:` header sets the type, `data:` is the payload.
   * - Inline type:  No `event:` header; `data.type` carries the event type
   *   and the payload is nested under a key (e.g. `data.part`, `data.run`).
   */
  private mapSSEEvent(type: string, data: string): AgentEvent | null {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;

      // Resolve event type: prefer explicit SSE event header, fall back to
      // the `type` field inside the JSON payload.
      const eventType = type || (parsed.type as string) || "";

      switch (eventType) {
        case "message.part": {
          // Inline format: { type, part: { content, ... } }
          // Legacy format: { content, ... }
          const part = (parsed.part ?? parsed) as Record<string, unknown>;
          return {
            type: "text",
            text: (part.content as string) ?? "",
            role: "assistant",
          };
        }
        case "run.completed": {
          // Inline format: { type, run: { output, ... } }
          // Legacy format: { output, ... }
          const run = (parsed.run ?? parsed) as Record<string, unknown>;
          return {
            type: "complete",
            reason: "end_turn",
            output: run.output as AgentMessage[],
          };
        }
        case "run.failed": {
          const run = (parsed.run ?? parsed) as Record<string, unknown>;
          const error = run.error as Record<string, unknown> | string | undefined;
          const message =
            typeof error === "string"
              ? error
              : (error?.message as string) ?? "Run failed";
          return {
            type: "error",
            code: "RUN_FAILED",
            message,
          };
        }
        case "run.awaiting": {
          const run = (parsed.run ?? parsed) as Record<string, unknown>;
          return { type: "pause", request: run.await_request };
        }
        default:
          return null;
      }
    } catch {
      return null;
    }
  }
}
