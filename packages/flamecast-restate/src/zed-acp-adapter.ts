/**
 * Zed ACP (Agent Client Protocol) adapter — JSON-RPC over stdio.
 *
 * Implements the AgentAdapter interface for communicating with Zed ACP agents
 * via JSON-RPC over stdin/stdout. For local processes, spawns the agent binary
 * with --acp flag. For containerized agents (URL-based), connects via HTTP to
 * a session-host relay.
 *
 * Reference: docs/sdd-durable-acp-bridge.md §2.3
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  AgentAdapter,
  AgentEvent,
  AgentMessage,
  AgentStartConfig,
  ConfigOption,
  PromptResult,
  SessionHandle,
} from "./adapter.js";
import { HttpJsonRpcConnection } from "./http-bridge.js";

// ─── JSON-RPC message types ──────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

// ─── JSON-RPC connection over stdio ──────────────────────────────────────────

/**
 * Manages a JSON-RPC connection over stdio to a Zed ACP agent.
 * Handles request/response correlation and notification dispatching.
 */
class JsonRpcConnection {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private events = new EventEmitter();
  private buffer = "";
  private process: ChildProcess;

  constructor(proc: ChildProcess) {
    this.process = proc;
    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk.toString()));
    proc.stderr!.on("data", (chunk: Buffer) => {
      // Agent stderr — log but don't fail
      console.error(`[zed-agent-stderr] ${chunk.toString().trimEnd()}`);
    });
    proc.on("exit", (code) => {
      // Reject all pending requests
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`Agent process exited with code ${code}`));
        this.pending.delete(id);
      }
      this.events.emit("exit", code);
    });
  }

  private onData(data: string): void {
    this.buffer += data;
    // JSON-RPC messages are newline-delimited
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        if ("id" in msg && msg.id !== undefined) {
          // Response to a request
          const pending = this.pending.get(msg.id as number);
          if (pending) {
            this.pending.delete(msg.id as number);
            const resp = msg as JsonRpcResponse;
            if (resp.error) {
              pending.reject(
                new Error(`${resp.error.message} (${resp.error.code})`),
              );
            } else {
              pending.resolve(resp.result);
            }
          }
        } else if ("method" in msg) {
          // Notification from agent
          this.events.emit("notification", msg as JsonRpcNotification);
        }
      } catch {
        // Non-JSON output — ignore
      }
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin!.write(JSON.stringify(msg) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.process.stdin!.write(JSON.stringify(msg) + "\n");
  }

  onNotification(listener: (msg: JsonRpcNotification) => void): void {
    this.events.on("notification", listener);
  }

  offNotification(listener: (msg: JsonRpcNotification) => void): void {
    this.events.off("notification", listener);
  }

  onExit(listener: (code: number | null) => void): void {
    this.events.on("exit", listener);
  }

  kill(): void {
    this.process.kill();
  }

  get pid(): number | undefined {
    return this.process.pid;
  }
}

// ─── Connection interface (shared by stdio + HTTP bridge) ───────────────────

type AnyJsonRpcConnection = JsonRpcConnection | HttpJsonRpcConnection;

// ─── Active connections by sessionId ─────────────────────────────────────────

const connections = new Map<string, AnyJsonRpcConnection>();

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class ZedAcpAdapter implements AgentAdapter {
  // --- Core lifecycle ---

  async start(config: AgentStartConfig): Promise<SessionHandle> {
    const sessionId = config.sessionId ?? randomUUID();

    // If config.agent is a URL (containerized agent behind HTTP bridge),
    // connect via HttpJsonRpcConnection instead of spawning locally.
    if (
      config.agent.startsWith("http://") ||
      config.agent.startsWith("https://")
    ) {
      const conn = await HttpJsonRpcConnection.connect(config.agent);

      // Initialize the ACP session (same protocol as stdio)
      const initResult = (await conn.request("initialize", {
        capabilities: {},
        clientInfo: { name: "flamecast", version: "1.0.0" },
      })) as {
        serverInfo?: { name?: string; description?: string };
        capabilities?: Record<string, unknown>;
      };

      const sessionResult = (await conn.request("session/new", {})) as {
        id?: string;
      };

      const handle: SessionHandle = {
        sessionId: sessionResult?.id ?? sessionId,
        protocol: "zed",
        agent: {
          name:
            initResult?.serverInfo?.name ??
            config.agent.split("/").pop() ??
            "zed-agent",
          description: initResult?.serverInfo?.description,
          capabilities: initResult?.capabilities,
        },
        connection: { url: config.agent },
      };

      connections.set(handle.sessionId, conn);

      conn.onExit(() => {
        connections.delete(handle.sessionId);
      });

      return handle;
    }

    // Local process — spawn with --acp flag
    const args = ["--acp"];
    const proc = spawn(config.agent, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
    });

    const conn = new JsonRpcConnection(proc);

    // Initialize the ACP session
    const initResult = (await conn.request("initialize", {
      capabilities: {},
      clientInfo: { name: "flamecast", version: "1.0.0" },
    })) as {
      serverInfo?: { name?: string; description?: string };
      capabilities?: Record<string, unknown>;
    };

    // Create a new session
    const sessionResult = (await conn.request("session/new", {})) as {
      id?: string;
    };

    const handle: SessionHandle = {
      sessionId: sessionResult?.id ?? sessionId,
      protocol: "zed",
      agent: {
        name:
          initResult?.serverInfo?.name ??
          config.agent.split("/").pop() ??
          "zed-agent",
        description: initResult?.serverInfo?.description,
        capabilities: initResult?.capabilities,
      },
      connection: { pid: proc.pid },
    };

    connections.set(handle.sessionId, conn);

    conn.onExit(() => {
      connections.delete(handle.sessionId);
    });

    return handle;
  }

  async cancel(session: SessionHandle): Promise<void> {
    const conn = connections.get(session.sessionId);
    if (!conn) return;
    // session/cancel is a notification (no response expected)
    conn.notify("session/cancel", { sessionId: session.sessionId });
  }

  async close(session: SessionHandle): Promise<void> {
    const conn = connections.get(session.sessionId);
    if (!conn) return;
    conn.kill();
    connections.delete(session.sessionId);
  }

  // --- Sync (VO handler, inside ctx.run(), journaled) ---

  async promptSync(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): Promise<PromptResult> {
    const conn = connections.get(session.sessionId);
    if (!conn)
      throw new Error(`No connection for session ${session.sessionId}`);

    const messages =
      typeof input === "string"
        ? [
            {
              role: "user" as const,
              parts: [{ contentType: "text/plain", content: input }],
            },
          ]
        : input;

    try {
      // session/prompt blocks until the agent completes or enters "awaiting"
      const result = (await conn.request("session/prompt", {
        sessionId: session.sessionId,
        messages,
      })) as {
        status?: string;
        output?: AgentMessage[];
        awaitRequest?: unknown;
        error?: string;
      };

      return {
        status: (result.status as PromptResult["status"]) ?? "completed",
        output: result.output,
        awaitRequest: result.awaitRequest,
        runId: session.sessionId, // Zed ACP: runId = sessionId
        error: result.error,
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        runId: session.sessionId,
      };
    }
  }

  async resumeSync(
    session: SessionHandle,
    _runId: string,
    payload: unknown,
  ): Promise<PromptResult> {
    const conn = connections.get(session.sessionId);
    if (!conn)
      throw new Error(`No connection for session ${session.sessionId}`);

    try {
      // For Zed ACP, resume returns the permission response which
      // unblocks the JSON-RPC response the agent is waiting for
      const result = (await conn.request("session/resume", {
        sessionId: session.sessionId,
        payload,
      })) as {
        status?: string;
        output?: AgentMessage[];
        awaitRequest?: unknown;
        error?: string;
      };

      return {
        status: (result.status as PromptResult["status"]) ?? "completed",
        output: result.output,
        awaitRequest: result.awaitRequest,
        runId: session.sessionId,
        error: result.error,
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        runId: session.sessionId,
      };
    }
  }

  // --- Streaming (API layer / client-direct, not journaled) ---

  async *prompt(
    session: SessionHandle,
    input: string | AgentMessage[],
  ): AsyncGenerator<AgentEvent> {
    const conn = connections.get(session.sessionId);
    if (!conn)
      throw new Error(`No connection for session ${session.sessionId}`);

    const messages =
      typeof input === "string"
        ? [
            {
              role: "user" as const,
              parts: [{ contentType: "text/plain", content: input }],
            },
          ]
        : input;

    // Collect events from agent notifications while the prompt is in-flight
    const events: AgentEvent[] = [];
    let done = false;
    let resolve: (() => void) | null = null;

    const onNotification = (msg: JsonRpcNotification) => {
      if (msg.method === "session/update") {
        const params = msg.params as
          | {
              type?: string;
              text?: string;
              toolCallId?: string;
              title?: string;
              status?: string;
              input?: unknown;
              output?: unknown;
            }
          | undefined;
        if (params?.type === "text") {
          events.push({
            type: "text",
            text: params.text ?? "",
            role: "assistant",
          });
        } else if (params?.type === "tool") {
          events.push({
            type: "tool",
            toolCallId: params.toolCallId ?? "",
            title: params.title ?? "",
            status:
              (params.status as
                | "pending"
                | "running"
                | "completed"
                | "failed") ?? "running",
            input: params.input,
            output: params.output,
          });
        }
        resolve?.();
      }
    };

    conn.onNotification(onNotification);

    // Send prompt (will block until complete)
    const promptPromise = conn
      .request("session/prompt", {
        sessionId: session.sessionId,
        messages,
      })
      .then((result) => {
        done = true;
        resolve?.();
        return result;
      })
      .catch((error) => {
        done = true;
        events.push({
          type: "error",
          code: "PROMPT_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
        resolve?.();
      });

    // Yield events as they arrive
    while (!done) {
      if (events.length > 0) {
        yield events.shift()!;
      } else {
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    }
    // Drain remaining events
    while (events.length > 0) {
      yield events.shift()!;
    }

    // Clean up notification listener
    conn.offNotification(onNotification);

    const result = await promptPromise;
    if (result) {
      const r = result as { output?: AgentMessage[] };
      yield { type: "complete", reason: "end_turn", output: r.output };
    }
  }

  async *resume(
    session: SessionHandle,
    payload: unknown,
  ): AsyncGenerator<AgentEvent> {
    // For streaming resume, delegate to resumeSync.
    // Zed ACP resume unblocks the pending permission request.
    const result = await this.resumeSync(session, session.sessionId, payload);
    if (result.status === "completed") {
      yield { type: "complete", reason: "end_turn", output: result.output };
    } else if (result.status === "awaiting") {
      yield { type: "pause", request: result.awaitRequest };
    } else if (result.status === "failed") {
      yield {
        type: "error",
        code: "RESUME_FAILED",
        message: result.error ?? "Resume failed",
      };
    }
  }

  // --- Config ---

  async getConfigOptions(session: SessionHandle): Promise<ConfigOption[]> {
    const conn = connections.get(session.sessionId);
    if (!conn) return [];
    try {
      const result = (await conn.request("session/getConfigOptions", {
        sessionId: session.sessionId,
      })) as ConfigOption[];
      return result ?? [];
    } catch {
      return [];
    }
  }

  async setConfigOption(
    session: SessionHandle,
    configId: string,
    value: string,
  ): Promise<ConfigOption[]> {
    const conn = connections.get(session.sessionId);
    if (!conn) return [];
    try {
      const result = (await conn.request("session/setConfigOption", {
        sessionId: session.sessionId,
        configId,
        value,
      })) as ConfigOption[];
      return result ?? [];
    } catch {
      return [];
    }
  }
}
