/**
 * HTTP+SSE JSON-RPC bridge for containerized ACP agents.
 *
 * Aligns with SDD §3.1 transport philosophy: REST for actions, SSE for events.
 *
 * Bridge server (runs inside container alongside agent):
 *   POST /jsonrpc — accepts JSON-RPC requests AND responses, writes to agent stdin
 *   GET /events   — SSE stream of all agent stdout (responses, notifications, requests)
 *
 * HttpJsonRpcConnection (client, runs in adapter):
 *   request()        — POST JSON-RPC request to /jsonrpc, await response via SSE
 *   notify()         — POST JSON-RPC notification to /jsonrpc (fire-and-forget)
 *   onNotification() — receive agent notifications via SSE
 *   onRequest()      — handle agent-initiated requests (e.g. request_permission),
 *                       automatically POSTs the response back to /jsonrpc
 *
 * Bidirectional request_permission flow:
 *   1. Agent writes request_permission (JSON-RPC request with id) to stdout
 *   2. Bridge emits it on SSE GET /events stream
 *   3. HttpJsonRpcConnection receives, calls onRequest handler
 *   4. Handler returns result, connection POSTs JSON-RPC response to /jsonrpc
 *   5. Bridge writes response to agent stdin — agent unblocks
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as http from "node:http";

// ─── JSON-RPC types ─────────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════════════════
// Part 1: Bridge Server
// ═══════════════════════════════════════════════════════════════════════════════

export interface BridgeServerOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  port?: number;
  host?: string;
}

export interface BridgeServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startBridgeServer(
  opts: BridgeServerOptions,
): Promise<BridgeServer> {
  const port = opts.port ?? 9100;
  const host = opts.host ?? "0.0.0.0";
  const args = opts.args ?? ["--acp"];

  const proc = spawn(opts.command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });

  let agentBuffer = "";
  const sseClients = new Set<http.ServerResponse>();
  let sseSeq = 0;

  // Agent stdout → parse newline-delimited JSON-RPC → emit as SSE events
  proc.stdout!.on("data", (chunk: Buffer) => {
    agentBuffer += chunk.toString();
    const lines = agentBuffer.split("\n");
    agentBuffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      sseSeq++;
      for (const res of sseClients) {
        res.write(`id: ${sseSeq}\ndata: ${trimmed}\n\n`);
      }
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    console.error(`[http-bridge-agent-stderr] ${chunk.toString().trimEnd()}`);
  });

  proc.on("exit", (code) => {
    for (const res of sseClients) {
      res.write(`event: exit\ndata: ${JSON.stringify({ code })}\n\n`);
      res.end();
    }
    sseClients.clear();
  });

  const server = http.createServer(async (req, res) => {
    // POST /jsonrpc — write to agent stdin
    if (req.method === "POST" && req.url === "/jsonrpc") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();

      // Write to agent stdin (newline-delimited)
      proc.stdin!.write(body + "\n");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /events — SSE stream of agent stdout
    if (req.method === "GET" && req.url?.startsWith("/events")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("\n"); // flush headers

      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    // GET /health
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          pid: proc.pid,
          exitCode: proc.exitCode,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  const actualPort = (server.address() as { port: number }).port;

  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}`,
    port: actualPort,
    async close() {
      proc.kill();
      for (const res of sseClients) {
        res.end();
      }
      sseClients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part 2: HttpJsonRpcConnection — client side
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * JSON-RPC connection over HTTP+SSE. Drop-in replacement for the stdio
 * JsonRpcConnection. Same public interface: request(), notify(),
 * onNotification(), offNotification(), onExit(), kill().
 *
 * Additionally supports onRequest() for agent-initiated bidirectional requests
 * (e.g. request_permission) — automatically POSTs the response back.
 */
export class HttpJsonRpcConnection {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private events = new EventEmitter();
  private baseUrl: string;
  private abortController: AbortController;
  private requestHandler:
    | ((method: string, params: unknown) => Promise<unknown>)
    | null = null;
  private connected = false;

  private constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.abortController = new AbortController();
  }

  /**
   * Connect to an HTTP bridge server and start consuming the SSE stream.
   */
  static async connect(baseUrl: string): Promise<HttpJsonRpcConnection> {
    const conn = new HttpJsonRpcConnection(baseUrl);
    await conn.startSSE();
    return conn;
  }

  private async startSSE(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: this.abortController.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed: ${res.status}`);
    }

    this.connected = true;

    // Parse SSE in background
    void this.consumeSSE(res.body).catch(() => {
      this.connected = false;
      this.events.emit("exit", null);
    });
  }

  private async consumeSSE(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const segments = buffer.split("\n\n");
        buffer = segments.pop()!;

        for (const segment of segments) {
          let eventType = "";
          let data = "";

          for (const line of segment.split("\n")) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              data += line.slice(5).trim();
            }
          }

          if (!data) continue;

          // Handle exit event
          if (eventType === "exit") {
            const parsed = JSON.parse(data) as { code: number | null };
            this.rejectAll(`Agent exited with code ${parsed.code}`);
            this.events.emit("exit", parsed.code);
            return;
          }

          // Parse JSON-RPC message from agent
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data);
          } catch {
            continue;
          }

          if (msg.jsonrpc !== "2.0") continue;
          this.handleMessage(msg);
        }
      }
    } finally {
      reader.releaseLock();
      this.connected = false;
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Case 1: Response to our request (has id + result or error)
    if (
      "id" in msg &&
      msg.id !== undefined &&
      ("result" in msg || "error" in msg)
    ) {
      const pending = this.pending.get(msg.id as number);
      if (pending) {
        this.pending.delete(msg.id as number);
        if (msg.error) {
          const err = msg.error as { code: number; message: string };
          pending.reject(new Error(`${err.message} (${err.code})`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Case 2: Agent-initiated request (has id + method — bidirectional RPC)
    if ("id" in msg && "method" in msg && msg.id !== undefined) {
      const reqId = msg.id as number;
      const method = msg.method as string;
      const params = msg.params;

      if (this.requestHandler) {
        this.requestHandler(method, params)
          .then((result) => {
            // POST the response back to the bridge → agent stdin
            void this.postJsonRpc({
              jsonrpc: "2.0",
              id: reqId,
              result,
            });
          })
          .catch((err: Error) => {
            void this.postJsonRpc({
              jsonrpc: "2.0",
              id: reqId,
              error: { code: -32000, message: err.message },
            });
          });
      } else {
        // No handler — emit as notification for backward compat
        this.events.emit("notification", {
          jsonrpc: "2.0",
          method,
          params,
        } as JsonRpcNotification);
      }
      return;
    }

    // Case 3: Notification (has method, no id)
    if ("method" in msg && !("id" in msg)) {
      this.events.emit("notification", msg as unknown as JsonRpcNotification);
    }
  }

  private async postJsonRpc(msg: unknown): Promise<void> {
    await fetch(`${this.baseUrl}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
  }

  private rejectAll(reason: string): void {
    for (const [, { reject }] of this.pending) {
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Send a JSON-RPC request and await the response. */
  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.postJsonRpc(msg).catch(reject);
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    void this.postJsonRpc(msg);
  }

  /** Register a handler for agent-initiated requests (bidirectional RPC). */
  onRequest(
    handler: (method: string, params: unknown) => Promise<unknown>,
  ): void {
    this.requestHandler = handler;
  }

  /** Listen for agent notifications. */
  onNotification(listener: (msg: JsonRpcNotification) => void): void {
    this.events.on("notification", listener);
  }

  /** Remove a notification listener. */
  offNotification(listener: (msg: JsonRpcNotification) => void): void {
    this.events.off("notification", listener);
  }

  /** Listen for connection close. */
  onExit(listener: (code: number | null) => void): void {
    this.events.on("exit", listener);
  }

  /** Close the SSE connection. */
  kill(): void {
    this.abortController.abort();
    this.rejectAll("Connection killed");
    this.connected = false;
  }

  /** Always undefined for HTTP connections (no local PID). */
  get pid(): number | undefined {
    return undefined;
  }
}
