import type * as acp from "@agentclientprotocol/sdk";
import { parseAcpMessage } from "./acp-streamable-http-messages.js";

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
  private readonly activeStreams = new Set<Promise<void>>();
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

  async start(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const request of this.activeRequests) {
      request.abort();
    }
    this.activeRequests.clear();
    this.activeStreams.clear();

    if (this.sessionId) {
      await this.fetchImpl(this.endpoint, {
        method: "DELETE",
        headers: this.createHeaders(),
      }).catch(() => undefined);
    }

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

      if (!response.ok) {
        throw new Error(await this.readErrorResponse(response));
      }

      if (response.status === 202 || !response.body) {
        return;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        throw new Error(`Unexpected ACP response content-type: ${contentType || "unknown"}`);
      }

      const streamTask = this.consumeEventStream(response.body)
        .catch((error) => {
          if (abortController.signal.aborted && this.closed) {
            return;
          }
          if (this.controller) {
            this.controller.error(error instanceof Error ? error : new Error(String(error)));
            this.controller = null;
          }
        })
        .finally(() => {
          this.activeStreams.delete(streamTask);
        });
      this.activeStreams.add(streamTask);
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

  private createHeaders(): Headers {
    const headers = new Headers({
      accept: "text/event-stream, application/json",
      "content-type": "application/json",
      [ACP_PROTOCOL_VERSION_HEADER]: this.protocolVersion,
    });
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

  private async consumeEventStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      buffer = this.flushEvents(buffer);
      if (done) {
        break;
      }
    }
  }

  private flushEvents(buffer: string): string {
    let remainder = buffer;
    while (true) {
      const boundary = remainder.indexOf("\n\n");
      if (boundary === -1) {
        return remainder;
      }

      const rawEvent = remainder.slice(0, boundary);
      remainder = remainder.slice(boundary + 2);

      const data = rawEvent
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");

      if (!data) {
        continue;
      }

      const parsed = parseAcpMessage(JSON.parse(data));
      if (!parsed) {
        throw new Error("Invalid ACP JSON-RPC message in event stream");
      }

      this.controller?.enqueue(parsed);
    }
  }
}
