import * as acp from "@agentclientprotocol/sdk";
import type {
  HandleRequestOptions,
  WebStandardStreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";

type StreamState = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  requestIds: Set<RequestId>;
  closed: boolean;
};

function isJsonRpcRequest(message: JSONRPCMessage): message is JSONRPCRequest {
  return "method" in message && "id" in message;
}

function isJsonRpcResponse(message: JSONRPCMessage): message is JSONRPCMessage & { id: RequestId } {
  return "id" in message && !("method" in message);
}

function isAcpInitializeRequest(message: JSONRPCMessage): message is JSONRPCRequest {
  return isJsonRpcRequest(message) && message.method === acp.AGENT_METHODS.initialize;
}

export class AcpStreamableHTTPServerTransport implements Transport {
  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly sessionIdGenerator?: () => string;
  private readonly onsessioninitialized?: (sessionId: string) => void | Promise<void>;
  private readonly onsessionclosed?: (sessionId: string) => void | Promise<void>;
  private initialized = false;
  private readonly streams = new Map<string, StreamState>();
  private readonly requestToStreamId = new Map<RequestId, string>();
  private readonly responseCache = new Map<RequestId, JSONRPCMessage>();

  constructor(options: WebStandardStreamableHTTPServerTransportOptions = {}) {
    this.sessionIdGenerator = options.sessionIdGenerator;
    this.onsessioninitialized = options.onsessioninitialized;
    this.onsessionclosed = options.onsessionclosed;
  }

  async start(): Promise<void> {}

  async handleRequest(req: Request, options: HandleRequestOptions = {}): Promise<Response> {
    switch (req.method) {
      case "POST":
        return this.handlePostRequest(req, options.parsedBody);
      case "GET":
        return new Response(null, {
          status: 405,
          headers: { Allow: "POST, DELETE" },
        });
      case "DELETE":
        return this.handleDeleteRequest(req);
      default:
        return new Response(null, {
          status: 405,
          headers: { Allow: "POST, DELETE" },
        });
    }
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const relatedRequestId = isJsonRpcResponse(message) ? message.id : options?.relatedRequestId;
    const streamId =
      relatedRequestId !== undefined
        ? this.requestToStreamId.get(relatedRequestId)
        : this.streams.size === 1
          ? this.streams.keys().next().value
          : undefined;
    if (!streamId) {
      // No active request-scoped stream is available for this outbound message.
      return;
    }

    const stream = this.streams.get(streamId);
    if (!stream || stream.closed) {
      throw new Error(`Response stream closed for request ID: ${String(relatedRequestId)}`);
    }

    this.writeSseEvent(stream, message);

    if (isJsonRpcResponse(message)) {
      const responseId = message.id;
      this.responseCache.set(responseId, message);
      const ready = [...stream.requestIds].every((requestId) => this.responseCache.has(requestId));
      if (ready) {
        this.closeStream(streamId);
      }
    }
  }

  async close(): Promise<void> {
    for (const streamId of [...this.streams.keys()]) {
      this.closeStream(streamId);
    }
    this.responseCache.clear();
    this.requestToStreamId.clear();
    this.onclose?.();
  }

  private async handlePostRequest(req: Request, parsedBody?: unknown): Promise<Response> {
    let rawMessage = parsedBody;
    if (rawMessage === undefined) {
      try {
        rawMessage = await req.json();
      } catch {
        return this.createJsonErrorResponse(400, -32700, "Parse error: Invalid JSON");
      }
    }

    const messages = Array.isArray(rawMessage) ? rawMessage : [rawMessage];
    if (messages.length === 0) {
      return this.createJsonErrorResponse(400, -32600, "Invalid Request");
    }

    const jsonRpcMessages: JSONRPCMessage[] = [];
    for (const message of messages) {
      const parsed = JSONRPCMessageSchema.safeParse(message);
      if (!parsed.success) {
        return this.createJsonErrorResponse(400, -32700, "Parse error: Invalid JSON-RPC message");
      }
      jsonRpcMessages.push(parsed.data);
    }
    const isInitializationRequest = jsonRpcMessages.some(isAcpInitializeRequest);

    if (isInitializationRequest) {
      if (this.initialized && this.sessionId !== undefined) {
        return this.createJsonErrorResponse(
          400,
          -32600,
          "Invalid Request: Server already initialized",
        );
      }
      if (jsonRpcMessages.length > 1) {
        return this.createJsonErrorResponse(
          400,
          -32600,
          "Invalid Request: Only one initialization request is allowed",
        );
      }
      this.sessionId = this.sessionIdGenerator?.();
      this.initialized = true;
      if (this.sessionId && this.onsessioninitialized) {
        await Promise.resolve(this.onsessioninitialized(this.sessionId));
      }
    } else {
      const sessionError = this.validateSession(req);
      if (sessionError) {
        return sessionError;
      }
    }

    const requestMessages = jsonRpcMessages.filter(isJsonRpcRequest);
    if (requestMessages.length === 0) {
      for (const message of jsonRpcMessages) {
        this.onmessage?.(message);
      }
      return new Response(null, { status: 202 });
    }

    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const streamId = crypto.randomUUID();
    const readable = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
      cancel: () => {
        this.closeStream(streamId);
      },
    });

    if (!controller) {
      return this.createJsonErrorResponse(500, -32603, "Internal Error");
    }

    this.streams.set(streamId, {
      controller,
      encoder,
      requestIds: new Set(requestMessages.map((message) => message.id)),
      closed: false,
    });

    for (const message of requestMessages) {
      this.requestToStreamId.set(message.id, streamId);
    }

    const headers = new Headers({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (this.sessionId) {
      headers.set("mcp-session-id", this.sessionId);
    }

    for (const message of jsonRpcMessages) {
      this.onmessage?.(message);
    }

    return new Response(readable, { status: 200, headers });
  }

  private async handleDeleteRequest(req: Request): Promise<Response> {
    const sessionError = this.validateSession(req);
    if (sessionError) {
      return sessionError;
    }

    if (this.sessionId && this.onsessionclosed) {
      await Promise.resolve(this.onsessionclosed(this.sessionId));
    }
    await this.close();
    return new Response(null, { status: 200 });
  }

  private validateSession(req: Request): Response | undefined {
    if (this.sessionIdGenerator === undefined) {
      return undefined;
    }
    if (!this.initialized) {
      return this.createJsonErrorResponse(400, -32000, "Bad Request: Server not initialized");
    }
    const sessionId = req.headers.get("mcp-session-id");
    if (!sessionId) {
      return this.createJsonErrorResponse(
        400,
        -32000,
        "Bad Request: Mcp-Session-Id header is required",
      );
    }
    if (sessionId !== this.sessionId) {
      return this.createJsonErrorResponse(404, -32001, "Session not found");
    }
    return undefined;
  }

  private writeSseEvent(stream: StreamState, message: JSONRPCMessage): void {
    const payload = `data: ${JSON.stringify(message)}\n\n`;
    stream.controller.enqueue(stream.encoder.encode(payload));
  }

  private closeStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.closed) {
      return;
    }
    stream.closed = true;
    try {
      stream.controller.close();
    } catch {
      // Ignore already-closed streams.
    }
    this.streams.delete(streamId);
    for (const requestId of stream.requestIds) {
      this.requestToStreamId.delete(requestId);
      this.responseCache.delete(requestId);
    }
  }

  private createJsonErrorResponse(status: number, code: number, message: string): Response {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    });
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}
