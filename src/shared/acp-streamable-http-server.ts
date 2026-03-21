import type * as acp from "@agentclientprotocol/sdk";
import {
  isInitializeRequest,
  isRequestMessage,
  isResponseMessage,
  parseServerInboundAcpMessages,
  type JsonRpcId,
} from "./acp-streamable-http-messages.js";

const ACP_SESSION_HEADER = "acp-session-id";

type ResponseStreamState = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  requestIds: Set<JsonRpcId>;
  closed: boolean;
};

type EventStreamState = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  closed: boolean;
};

type AcpStreamableHttpServerOptions = {
  sessionIdGenerator?: () => string;
  onsessioninitialized?: (sessionId: string) => void | Promise<void>;
  onsessionclosed?: (sessionId: string) => void | Promise<void>;
};

type HandleRequestOptions = {
  parsedBody?: unknown;
};

export class AcpStreamableHttpServerTransport {
  readonly stream: acp.Stream;

  sessionId?: string;

  private readonly sessionIdGenerator?: () => string;
  private readonly onsessioninitialized?: (sessionId: string) => void | Promise<void>;
  private readonly onsessionclosed?: (sessionId: string) => void | Promise<void>;
  private initialized = false;
  private readonly responseStreams = new Map<string, ResponseStreamState>();
  private readonly requestToStreamId = new Map<JsonRpcId, string>();
  private readonly responseCache = new Map<JsonRpcId, acp.AnyMessage>();
  private readonly pendingEventMessages: acp.AnyMessage[] = [];
  private eventStream: EventStreamState | null = null;
  private controller: ReadableStreamDefaultController<acp.AnyMessage> | null = null;

  constructor(options: AcpStreamableHttpServerOptions = {}) {
    this.sessionIdGenerator = options.sessionIdGenerator;
    this.onsessioninitialized = options.onsessioninitialized;
    this.onsessionclosed = options.onsessionclosed;
    this.stream = {
      readable: new ReadableStream<acp.AnyMessage>({
        start: (controller) => {
          this.controller = controller;
        },
        cancel: async () => {
          await this.close();
        },
      }),
      writable: new WritableStream<acp.AnyMessage>({
        write: (message) => this.send(message),
        close: async () => {
          await this.close();
        },
        abort: async () => {
          await this.close();
        },
      }),
    };
  }

  async handleRequest(req: Request, options: HandleRequestOptions = {}): Promise<Response> {
    switch (req.method) {
      case "POST":
        return this.handlePostRequest(req, options.parsedBody);
      case "GET":
        return this.handleGetRequest(req);
      case "DELETE":
        return this.handleDeleteRequest(req);
      default:
        return new Response(null, {
          status: 405,
          headers: { Allow: "GET, POST, DELETE" },
        });
    }
  }

  async close(): Promise<void> {
    for (const streamId of [...this.responseStreams.keys()]) {
      this.closeResponseStream(streamId);
    }
    this.closeEventStream();
    this.pendingEventMessages.length = 0;
    this.responseCache.clear();
    this.requestToStreamId.clear();
    if (this.controller) {
      this.controller.close();
      this.controller = null;
    }
  }

  private async send(message: acp.AnyMessage): Promise<void> {
    const relatedRequestId = isResponseMessage(message) ? message.id : undefined;
    const responseStreamId =
      relatedRequestId !== undefined ? this.requestToStreamId.get(relatedRequestId) : undefined;

    if (!responseStreamId) {
      this.enqueueEventMessage(message);
      return;
    }

    const stream = this.responseStreams.get(responseStreamId);
    if (!stream || stream.closed) {
      throw new Error(`Response stream closed for request ID: ${String(relatedRequestId)}`);
    }

    this.writeSseEvent(stream, message);

    if (relatedRequestId === undefined) {
      return;
    }
    this.responseCache.set(relatedRequestId, message);
    const ready = [...stream.requestIds].every((requestId) => this.responseCache.has(requestId));
    if (ready) {
      this.closeResponseStream(responseStreamId);
    }
  }

  private async handleGetRequest(req: Request): Promise<Response> {
    const sessionError = this.validateSession(req);
    if (sessionError) {
      return sessionError;
    }

    this.closeEventStream();

    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const readable = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
      cancel: () => {
        this.closeEventStream();
      },
    });

    if (!controller) {
      return this.createJsonErrorResponse(500, -32603, "Internal Error");
    }

    this.eventStream = {
      controller,
      encoder,
      closed: false,
    };
    this.flushPendingEventMessages();

    return new Response(readable, {
      status: 200,
      headers: this.createSseHeaders(),
    });
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

    const messages = parseServerInboundAcpMessages(rawMessage);
    if (!messages) {
      return this.createJsonErrorResponse(400, -32600, "Invalid JSON-RPC message");
    }

    const isInitializationRequest = messages.some(isInitializeRequest);
    if (isInitializationRequest) {
      if (this.initialized && this.sessionId !== undefined) {
        return this.createJsonErrorResponse(
          400,
          -32600,
          "Invalid Request: Server already initialized",
        );
      }
      if (messages.length > 1) {
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

    const requestMessages = messages.filter(isRequestMessage);
    if (requestMessages.length === 0) {
      for (const message of messages) {
        this.controller?.enqueue(message);
      }
      return new Response(null, { status: 202 });
    }

    for (const message of messages) {
      this.controller?.enqueue(message);
    }

    if (!isInitializationRequest && this.eventStream && !this.eventStream.closed) {
      return new Response(null, {
        status: 202,
        headers: this.createAcceptedHeaders(),
      });
    }

    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const streamId = crypto.randomUUID();
    const readable = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
      cancel: () => {
        this.closeResponseStream(streamId);
      },
    });

    if (!controller) {
      return this.createJsonErrorResponse(500, -32603, "Internal Error");
    }

    this.responseStreams.set(streamId, {
      controller,
      encoder,
      requestIds: new Set(requestMessages.map((message) => message.id)),
      closed: false,
    });

    for (const message of requestMessages) {
      this.requestToStreamId.set(message.id, streamId);
    }

    return new Response(readable, {
      status: 200,
      headers: this.createSseHeaders(),
    });
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
    const sessionId = req.headers.get(ACP_SESSION_HEADER);
    if (!sessionId) {
      return this.createJsonErrorResponse(
        400,
        -32000,
        "Bad Request: acp-session-id header is required",
      );
    }
    if (sessionId !== this.sessionId) {
      return this.createJsonErrorResponse(404, -32001, "Session not found");
    }
    return undefined;
  }

  private enqueueEventMessage(message: acp.AnyMessage): void {
    if (!this.eventStream || this.eventStream.closed) {
      this.pendingEventMessages.push(message);
      return;
    }

    this.writeSseEvent(this.eventStream, message);
  }

  private flushPendingEventMessages(): void {
    if (!this.eventStream || this.eventStream.closed) {
      return;
    }

    while (this.pendingEventMessages.length > 0) {
      const message = this.pendingEventMessages.shift();
      if (message) {
        this.writeSseEvent(this.eventStream, message);
      }
    }
  }

  private createSseHeaders(): Headers {
    const headers = new Headers({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (this.sessionId) {
      headers.set(ACP_SESSION_HEADER, this.sessionId);
    }
    return headers;
  }

  private createAcceptedHeaders(): Headers {
    const headers = new Headers();
    if (this.sessionId) {
      headers.set(ACP_SESSION_HEADER, this.sessionId);
    }
    return headers;
  }

  private writeSseEvent(
    stream: ResponseStreamState | EventStreamState,
    message: acp.AnyMessage,
  ): void {
    const payload = `data: ${JSON.stringify(message)}\n\n`;
    stream.controller.enqueue(stream.encoder.encode(payload));
  }

  private closeResponseStream(streamId: string): void {
    const stream = this.responseStreams.get(streamId);
    if (!stream || stream.closed) {
      return;
    }

    stream.closed = true;
    try {
      stream.controller.close();
    } catch {
      // Ignore already-closed streams.
    }

    this.responseStreams.delete(streamId);
    for (const requestId of stream.requestIds) {
      this.requestToStreamId.delete(requestId);
      this.responseCache.delete(requestId);
    }
  }

  private closeEventStream(): void {
    if (!this.eventStream || this.eventStream.closed) {
      return;
    }

    this.eventStream.closed = true;
    try {
      this.eventStream.controller.close();
    } catch {
      // Ignore already-closed streams.
    }
    this.eventStream = null;
  }

  private createJsonErrorResponse(status: number, code: number, message: string): Response {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
      }),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  }
}
