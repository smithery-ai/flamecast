import type * as acp from "@agentclientprotocol/sdk";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { parseClientInboundAcpMessage } from "./acp-streamable-http-messages.js";

const ACP_HTTP_PROTOCOL_VERSION = "2025-11-25";
const ACP_PROTOCOL_VERSION_HEADER = "acp-protocol-version";
const ACP_SESSION_HEADER = "acp-session-id";

type AcpStreamableHttpClientOptions = {
  fetch?: typeof fetch;
  protocolVersion?: string;
};

type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export class AcpStreamableHttpClientTransport {
  readonly stream: acp.Stream;

  private readonly endpoint: URL;
  private readonly fetchImpl: FetchLike;
  private readonly protocolVersion: string;
  private readonly activeRequests = new Set<AbortController>();
  private eventStreamAbort: AbortController | null = null;
  private eventStreamTask: Promise<void> | null = null;
  private controller: ReadableStreamDefaultController<acp.AnyMessage> | null = null;
  private closed = false;
  private sessionId: string | null = null;

  constructor(endpoint: URL, options: AcpStreamableHttpClientOptions = {}) {
    this.endpoint = endpoint;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    this.fetchImpl = (input, init) => fetchImpl.call(globalThis, input, init);
    this.protocolVersion = options.protocolVersion ?? ACP_HTTP_PROTOCOL_VERSION;
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

  async start(): Promise<void> {
    this.ensureEventStream();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const request of this.activeRequests) {
      request.abort();
    }
    this.activeRequests.clear();

    this.eventStreamAbort?.abort();
    this.eventStreamAbort = null;

    if (this.sessionId) {
      await this.fetchImpl(this.endpoint, {
        method: "DELETE",
        headers: this.createHeaders({ accept: "application/json" }),
      }).catch(() => undefined);
    }

    await this.eventStreamTask?.catch(() => undefined);

    if (this.controller) {
      this.controller.close();
      this.controller = null;
    }
  }

  private async send(message: acp.AnyMessage): Promise<void> {
    if (this.closed) {
      throw new Error("ACP transport is closed");
    }

    const abortController = new AbortController();
    this.activeRequests.add(abortController);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.createHeaders(),
        body: JSON.stringify(message),
        signal: abortController.signal,
      });

      this.captureSessionId(response);
      this.ensureEventStream();

      if (!response.ok) {
        throw new Error(await this.readErrorResponse(response));
      }

      if (response.status === 202 || !response.body) {
        return;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        await this.consumeJsonResponse(response);
        return;
      }

      if (!contentType.includes("text/event-stream")) {
        throw new Error(`Unexpected ACP response content-type: ${contentType || "unknown"}`);
      }

      await this.consumeEventStream(response.body);
      return;
    } catch (error) {
      if (abortController.signal.aborted && this.closed) {
        return;
      }
      throw error;
    } finally {
      this.activeRequests.delete(abortController);
    }
  }

  private createHeaders(opts?: {
    accept?: string;
    includeContentType?: boolean;
  }): Headers {
    const headers = new Headers({
      accept: opts?.accept ?? "text/event-stream, application/json",
      [ACP_PROTOCOL_VERSION_HEADER]: this.protocolVersion,
    });
    if (opts?.includeContentType !== false) {
      headers.set("content-type", "application/json");
    }
    if (this.sessionId) {
      headers.set(ACP_SESSION_HEADER, this.sessionId);
    }
    return headers;
  }

  private captureSessionId(response: Response): void {
    const sessionId = response.headers.get(ACP_SESSION_HEADER);
    if (!sessionId) {
      return;
    }

    if (this.sessionId && this.sessionId !== sessionId) {
      throw new Error("ACP transport session switched unexpectedly");
    }

    this.sessionId = sessionId;
  }

  private ensureEventStream(): void {
    if (this.closed || !this.sessionId || this.eventStreamTask) {
      return;
    }

    const abortController = new AbortController();
    this.eventStreamAbort = abortController;
    const task = this.runEventStream(abortController).catch((error) => {
      if (abortController.signal.aborted && this.closed) {
        return;
      }
      if (this.controller) {
        this.controller.error(error instanceof Error ? error : new Error(String(error)));
        this.controller = null;
      }
    });
    const trackedTask = task.finally(() => {
      if (this.eventStreamAbort === abortController) {
        this.eventStreamAbort = null;
      }
      if (this.eventStreamTask === trackedTask) {
        this.eventStreamTask = null;
      }
    });
    this.eventStreamTask = trackedTask;
  }

  private async runEventStream(abortController: AbortController): Promise<void> {
    while (!this.closed && !abortController.signal.aborted) {
      const response = await this.fetchImpl(this.endpoint, {
        method: "GET",
        headers: this.createHeaders({
          accept: "text/event-stream",
          includeContentType: false,
        }),
        signal: abortController.signal,
      });

      this.captureSessionId(response);

      if (!response.ok) {
        throw new Error(await this.readErrorResponse(response));
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        throw new Error(
          `Unexpected ACP event-stream content-type: ${contentType || "unknown"}`,
        );
      }
      if (!response.body) {
        throw new Error("ACP event stream opened without a response body");
      }

      await this.consumeEventStream(response.body);

      if (!this.closed && !abortController.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  private async readErrorResponse(response: Response): Promise<string> {
    const payload = await response.json().catch(() => null);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "object" &&
      payload.error !== null &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
    ) {
      return payload.error.message;
    }

    return response.statusText || "ACP HTTP request failed";
  }

  private async consumeJsonResponse(response: Response): Promise<void> {
    const payload = await response.json().catch(() => null);
    const parsed = parseClientInboundAcpMessage(payload);
    if (!parsed) {
      throw new Error("Invalid ACP JSON-RPC message in response body");
    }
    this.controller?.enqueue(parsed);
  }

  private async consumeEventStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
      .getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const parsed = parseClientInboundAcpMessage(JSON.parse(value.data));
      if (!parsed) {
        throw new Error("Invalid ACP JSON-RPC message in event stream");
      }
      this.controller?.enqueue(parsed);
    }
  }
}
