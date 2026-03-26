import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import * as acp from "@agentclientprotocol/sdk";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Runtime } from "@flamecast/protocol/runtime";
import type { SessionHostStartRequest, SessionHostStartResponse } from "@flamecast/protocol/session-host";
import type { WsControlMessage, WsServerMessage } from "@flamecast/protocol/ws";

const JSON_HEADERS = { "Content-Type": "application/json" };

type RemoteAcpTransport = {
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
  dispose?: () => Promise<void>;
};

type AgentJsRuntimeOptions = {
  baseUrl?: string;
  websocketUrl?: string;
  headers?: Record<string, string>;
};

type StartBody = SessionHostStartRequest & {
  baseUrl?: string;
  websocketUrl?: string;
};

type ManagedSession = {
  id: string;
  agentSessionId: string;
  connection: acp.ClientSideConnection | null;
  transport: RemoteAcpTransport;
  clients: Set<WebSocket>;
  permissionResolvers: Map<string, (response: acp.RequestPermissionResponse) => void>;
  promptInFlight: boolean;
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function toUint8Array(data: RawData): Uint8Array | Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer().then((value) => new Uint8Array(value));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new TextEncoder().encode(String(data));
}

async function openWorkerAcpTransport(
  url: string,
  init: ConstructorParameters<typeof WebSocket>[1] = {},
): Promise<RemoteAcpTransport> {
  const ws = new WebSocket(url, init);

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      ws.off("open", onOpen);
      reject(error);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
  });

  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      ws.on("message", (data) => {
        void Promise.resolve(toUint8Array(data)).then((value) => controller.enqueue(value));
      });
      ws.once("close", () => controller.close());
      ws.once("error", (error) => controller.error(error));
    },
    cancel() {
      ws.close();
    },
  });

  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        ws.send(Buffer.from(chunk), (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    close() {
      ws.close(1000, "ACP transport closed");
    },
    abort() {
      ws.close(1011, "ACP transport aborted");
    },
  });

  return {
    input,
    output,
    dispose: async () => {
      if (ws.readyState === WebSocket.CLOSED) {
        return;
      }

      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timeout);
          ws.off("close", finish);
          resolve();
        };
        const timeout = setTimeout(() => {
          ws.terminate();
          finish();
        }, 250);

        ws.once("close", finish);

        if (ws.readyState === WebSocket.CONNECTING) {
          ws.once("open", () => ws.close(1000, "ACP transport disposed"));
          return;
        }

        ws.close(1000, "ACP transport disposed");
      });
    },
  };
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function resolveRemoteAcpUrl(
  sessionId: string,
  runtime: StartBody,
  defaults: AgentJsRuntimeOptions,
): string {
  const websocketUrl = runtime.websocketUrl ?? defaults.websocketUrl;
  if (websocketUrl) {
    const url = new URL(websocketUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(sessionId)}`;
    return url.toString();
  }

  const baseUrl = runtime.baseUrl ?? defaults.baseUrl;
  if (!baseUrl) {
    throw new Error('agent.js runtime requires "baseUrl" or "websocketUrl"');
  }

  const url = new URL(`/acp/${encodeURIComponent(sessionId)}`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class AgentJsRuntime implements Runtime<Pick<StartBody, "baseUrl" | "websocketUrl">> {
  private readonly defaults: AgentJsRuntimeOptions;
  private readonly sessions = new Map<string, ManagedSession>();
  private server: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private serverBaseUrl: string | null = null;
  private serverInit: Promise<void> | null = null;

  constructor(options: AgentJsRuntimeOptions = {}) {
    this.defaults = options;
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/start" && request.method === "POST") {
      return this.handleStart(sessionId, request);
    }
    if (path === "/terminate" && request.method === "POST") {
      return this.handleTerminate(sessionId);
    }
    if (path === "/prompt" && request.method === "POST") {
      return this.handlePrompt(sessionId, request);
    }
    if (path === "/queue" && request.method === "GET") {
      return this.handleQueue(sessionId);
    }
    if (path.startsWith("/permissions/") && request.method === "POST") {
      return this.handlePermission(sessionId, decodeURIComponent(path.slice("/permissions/".length)), request);
    }

    return jsonResponse({ error: `Unsupported path "${path}"` }, 404);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId)));
    this.sessions.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }

    this.serverBaseUrl = null;
    this.serverInit = null;
  }

  private async handleStart(sessionId: string, request: Request): Promise<Response> {
    if (this.sessions.has(sessionId)) {
      return jsonResponse({ error: `Session "${sessionId}" already exists` }, 409);
    }

    try {
      await this.ensureServer();

      const body = JSON.parse(await request.text()) as StartBody;
      const transport = await openWorkerAcpTransport(
        resolveRemoteAcpUrl(sessionId, body, this.defaults),
        this.defaults.headers ? { headers: this.defaults.headers } : undefined,
      );
      const session = this.createManagedSession(sessionId, transport);

      try {
        if (!session.connection) {
          throw new Error(`Session "${sessionId}" is not connected`);
        }

        await session.connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const created = await session.connection.newSession({
          cwd: body.workspace,
          mcpServers: [],
        });
        session.agentSessionId = created.sessionId;
        this.sessions.set(sessionId, session);
      } catch (error) {
        await transport.dispose?.();
        throw error;
      }

      const baseUrl = this.requireServerBaseUrl();
      const result: SessionHostStartResponse = {
        acpSessionId: session.agentSessionId,
        hostUrl: `${baseUrl}/sessions/${encodeURIComponent(sessionId)}`,
        websocketUrl: baseUrl
          .replace(/^http(s?):/, "ws$1:")
          .concat(`/sessions/${encodeURIComponent(sessionId)}`),
      };

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: JSON_HEADERS,
      });
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : "Failed to start agent.js session" },
        500,
      );
    }
  }

  private async handleTerminate(sessionId: string): Promise<Response> {
    if (!this.sessions.has(sessionId)) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    await this.closeSession(sessionId);
    return jsonResponse({ ok: true });
  }

  private async handlePrompt(sessionId: string, request: Request): Promise<Response> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    if (session.promptInFlight) {
      return jsonResponse({ error: "A prompt is already running" }, 409);
    }

    try {
      const body = JSON.parse(await request.text()) as { text?: string };
      if (!body.text) {
        return jsonResponse({ error: "Missing 'text' field" }, 400);
      }

      const result = await this.executePrompt(session, body.text);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: JSON_HEADERS,
      });
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : "Prompt failed" },
        500,
      );
    }
  }

  private handleQueue(sessionId: string): Response {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    return jsonResponse({
      processing: session.promptInFlight,
      paused: false,
      items: [],
      size: 0,
    });
  }

  private async handlePermission(
    sessionId: string,
    requestId: string,
    request: Request,
  ): Promise<Response> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    const resolver = session.permissionResolvers.get(requestId);
    if (!resolver) {
      return jsonResponse({ error: `Permission request "${requestId}" not found` }, 404);
    }

    const body = JSON.parse(await request.text()) as { optionId?: string; outcome?: "cancelled" };
    session.permissionResolvers.delete(requestId);

    const response: acp.RequestPermissionResponse =
      typeof body.optionId === "string"
        ? { outcome: { outcome: "selected", optionId: body.optionId } }
        : { outcome: { outcome: "cancelled" } };

    this.emitRpc(session, acp.CLIENT_METHODS.session_request_permission, "client_to_agent", "response", response);
    resolver(response);
    this.emitEvent(session, response.outcome.outcome === "selected" ? "permission_approved" : "permission_rejected", {
      requestId,
      response,
    });
    return jsonResponse({ ok: true });
  }

  private createManagedSession(sessionId: string, transport: RemoteAcpTransport): ManagedSession {
    const session: ManagedSession = {
      id: sessionId,
      agentSessionId: sessionId,
      transport,
      clients: new Set(),
      permissionResolvers: new Map(),
      promptInFlight: false,
      connection: null,
    };

    const client: acp.Client = {
      sessionUpdate: async (params) => {
        this.emitRpc(session, acp.CLIENT_METHODS.session_update, "agent_to_client", "notification", params);
      },
      requestPermission: async (params) => {
        this.emitRpc(
          session,
          acp.CLIENT_METHODS.session_request_permission,
          "agent_to_client",
          "request",
          params,
        );

        const requestId = crypto.randomUUID();
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          session.permissionResolvers.set(requestId, resolve);
          this.emitEvent(session, "permission_request", {
            requestId,
            toolCallId: params.toolCall.toolCallId,
            title: params.toolCall.title ?? "",
            kind: params.toolCall.kind ?? undefined,
            options: params.options.map((option) => ({
              optionId: option.optionId,
              name: option.name,
              kind: String(option.kind),
            })),
          });
        });
      },
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
      createTerminal: async () => ({ terminalId: `stub-${crypto.randomUUID()}` }),
      terminalOutput: async () => ({ output: "", truncated: false }),
      releaseTerminal: async () => ({}),
      waitForTerminalExit: async () => ({ exitCode: 0 }),
      killTerminal: async () => ({}),
      extMethod: async (method) => {
        throw acp.RequestError.methodNotFound(method);
      },
      extNotification: async () => {},
    };

    session.connection = new acp.ClientSideConnection(
      () => client,
      acp.ndJsonStream(transport.input, transport.output),
    );

    return session;
  }

  private async executePrompt(session: ManagedSession, text: string): Promise<acp.PromptResponse> {
    session.promptInFlight = true;
    const params: acp.PromptRequest = {
      sessionId: session.agentSessionId,
      prompt: [{ type: "text", text }],
    };

    this.emitRpc(session, acp.AGENT_METHODS.session_prompt, "client_to_agent", "request", params);

    try {
      if (!session.connection) {
        throw new Error(`Session "${session.id}" is not connected`);
      }

      const result = await session.connection.prompt(params);
      this.emitRpc(session, acp.AGENT_METHODS.session_prompt, "agent_to_client", "response", result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Prompt failed";
      this.broadcast(session, { type: "error", message });
      throw error;
    } finally {
      session.promptInFlight = false;
    }
  }

  private emitEvent(session: ManagedSession, type: string, data: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    this.broadcast(session, {
      type: "event",
      timestamp,
      event: { type, data, timestamp },
    });
  }

  private emitRpc(
    session: ManagedSession,
    method: string,
    direction: "client_to_agent" | "agent_to_client",
    phase: "request" | "response" | "notification",
    payload?: unknown,
  ): void {
    const data: Record<string, unknown> = { method, direction, phase };
    if (payload !== undefined) {
      data.payload = payload;
    }
    this.emitEvent(session, "rpc", data);
  }

  private broadcast(session: ManagedSession, message: WsServerMessage): void {
    const data = JSON.stringify(message);
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  private async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.sessions.delete(sessionId);

    for (const client of session.clients) {
      client.close(1000, "Session terminated");
    }
    session.clients.clear();
    session.permissionResolvers.clear();
    await session.transport.dispose?.();
  }

  private async ensureServer(): Promise<void> {
    if (this.serverBaseUrl) {
      return;
    }
    if (this.serverInit) {
      return this.serverInit;
    }

    this.serverInit = new Promise<void>((resolve, reject) => {
      const server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          const match = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(queue|files|fs\/snapshot))?$/);
          if (!match) {
            res.writeHead(404, JSON_HEADERS);
            res.end(JSON.stringify({ error: "Not found" }));
            return;
          }

          const [, encodedSessionId, resource = ""] = match;
          const session = this.sessions.get(decodeURIComponent(encodedSessionId));
          if (!session) {
            res.writeHead(404, JSON_HEADERS);
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }

          if (resource === "queue" && req.method === "GET") {
            res.writeHead(200, JSON_HEADERS);
            res.end(
              JSON.stringify({
                processing: session.promptInFlight,
                paused: false,
                items: [],
                size: 0,
              }),
            );
            return;
          }

          if (resource === "fs/snapshot" && req.method === "GET") {
            res.writeHead(200, JSON_HEADERS);
            res.end(
              JSON.stringify({
                root: "/",
                entries: [],
                truncated: false,
                maxEntries: 0,
              }),
            );
            return;
          }

          if (resource === "files" && req.method === "GET") {
            res.writeHead(404, JSON_HEADERS);
            res.end(JSON.stringify({ error: "File preview is not supported by agent.js runtime" }));
            return;
          }

          if (req.method === "POST" && resource === "") {
            const body = JSON.parse(await readRequestBody(req)) as WsControlMessage;
            await this.handleWsControl(session, body);
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          res.writeHead(404, JSON_HEADERS);
          res.end(JSON.stringify({ error: "Not found" }));
        } catch (error) {
          res.writeHead(500, JSON_HEADERS);
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Unexpected adapter error",
            }),
          );
        }
      });

      const wss = new WebSocketServer({ noServer: true });

      server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const match = url.pathname.match(/^\/sessions\/([^/]+)$/);
        if (!match) {
          socket.destroy();
          return;
        }

        const session = this.sessions.get(decodeURIComponent(match[1]));
        if (!session) {
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          session.clients.add(ws);
          ws.send(JSON.stringify({ type: "connected", sessionId: session.id } satisfies WsServerMessage));
          ws.on("message", (message) => {
            let body: WsControlMessage;
            try {
              body = JSON.parse(String(message));
            } catch {
              ws.send(JSON.stringify({ type: "error", message: "Invalid message format" } satisfies WsServerMessage));
              return;
            }

            void this.handleWsControl(session, body).catch((error) => {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: error instanceof Error ? error.message : "Command failed",
                } satisfies WsServerMessage),
              );
            });
          });
          ws.on("close", () => {
            session.clients.delete(ws);
          });
        });
      });

      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to determine agent.js adapter address"));
          return;
        }

        this.server = server;
        this.wss = wss;
        this.serverBaseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    try {
      await this.serverInit;
    } finally {
      this.serverInit = null;
    }
  }

  private async handleWsControl(session: ManagedSession, message: WsControlMessage): Promise<void> {
    switch (message.action) {
      case "prompt":
        if (session.promptInFlight) {
          throw new Error("A prompt is already running");
        }
        await this.executePrompt(session, message.text);
        return;
      case "permission.respond": {
        const resolver = session.permissionResolvers.get(message.requestId);
        if (!resolver) {
          throw new Error(`Permission request "${message.requestId}" not found`);
        }
        session.permissionResolvers.delete(message.requestId);
        const response: acp.RequestPermissionResponse =
          "optionId" in message.body
            ? { outcome: { outcome: "selected", optionId: message.body.optionId } }
            : { outcome: { outcome: "cancelled" } };
        this.emitRpc(
          session,
          acp.CLIENT_METHODS.session_request_permission,
          "client_to_agent",
          "response",
          response,
        );
        resolver(response);
        return;
      }
      case "terminate":
        await this.closeSession(session.id);
        return;
      case "ping":
      case "cancel":
      case "queue.clear":
      case "queue.pause":
      case "queue.resume":
      case "queue.reorder":
        return;
    }
  }

  private requireServerBaseUrl(): string {
    if (!this.serverBaseUrl) {
      throw new Error("agent.js adapter server is not initialized");
    }
    return this.serverBaseUrl;
  }
}
