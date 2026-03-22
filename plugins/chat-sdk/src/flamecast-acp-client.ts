import * as acp from "@agentclientprotocol/sdk";
import { AcpStreamableHttpClientTransport } from "@acp/flamecast/shared/acp-streamable-http-client";
import type { DriverPromptResult, DriverSessionClient } from "./driver.js";

type FlamecastAcpClientOptions = {
  endpoint: URL;
  fetch?: typeof fetch;
};

class PromptCaptureClient implements acp.Client {
  private readonly promptBuffers = new Map<string, string[]>();

  startPrompt(sessionId: string): void {
    this.promptBuffers.set(sessionId, []);
  }

  finishPrompt(sessionId: string): string {
    const parts = this.promptBuffers.get(sessionId) ?? [];
    this.promptBuffers.delete(sessionId);
    return parts.join("");
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    const content =
      "content" in update && typeof update.content === "object" && update.content !== null
        ? update.content
        : null;
    if (
      typeof update.sessionUpdate === "string" &&
      update.sessionUpdate.startsWith("agent_message") &&
      !Array.isArray(content) &&
      content?.type === "text" &&
      typeof content.text === "string"
    ) {
      this.promptBuffers.get(params.sessionId)?.push(content.text);
    }
  }

  async requestPermission(): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: "cancelled" } };
  }

  async readTextFile(): Promise<acp.ReadTextFileResponse> {
    throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.fs_read_text_file);
  }

  async writeTextFile(): Promise<acp.WriteTextFileResponse> {
    throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.fs_write_text_file);
  }

  async createTerminal(): Promise<acp.CreateTerminalResponse> {
    throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.terminal_create);
  }

  async terminalOutput(): Promise<acp.TerminalOutputResponse> {
    throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.terminal_output);
  }

  async releaseTerminal(): Promise<void> {
    throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.terminal_release);
  }

  async waitForTerminalExit(): Promise<acp.WaitForTerminalExitResponse> {
    throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.terminal_wait_for_exit);
  }

  async killTerminal(): Promise<void> {
    throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.terminal_kill);
  }

  async extMethod(method: string): Promise<Record<string, unknown>> {
    throw acp.RequestError.methodNotFound(method);
  }

  async extNotification(): Promise<void> {}
}

export class FlamecastAcpClient implements DriverSessionClient {
  private readonly endpoint: URL;
  private readonly fetchImpl?: typeof fetch;
  private readonly promptCaptureClient = new PromptCaptureClient();
  private readonly loadedSessionIds = new Set<string>();
  private connectionPromise: Promise<acp.ClientSideConnection> | null = null;
  private transport: AcpStreamableHttpClientTransport | null = null;

  constructor(options: FlamecastAcpClientOptions) {
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetch;
  }

  async createSession(cwd: string): Promise<string> {
    const connection = await this.getConnection();
    const response = await connection.newSession({
      cwd,
      mcpServers: [],
    });
    this.loadedSessionIds.add(response.sessionId);
    return response.sessionId;
  }

  async promptSession(sessionId: string, cwd: string, text: string): Promise<DriverPromptResult> {
    const connection = await this.getConnection();
    await this.ensureSessionLoaded(connection, sessionId, cwd);
    this.promptCaptureClient.startPrompt(sessionId);

    try {
      const response = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text }],
      });

      return {
        stopReason: response.stopReason,
        replyText: this.promptCaptureClient.finishPrompt(sessionId),
      };
    } catch (error) {
      this.promptCaptureClient.finishPrompt(sessionId);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.loadedSessionIds.clear();
    this.connectionPromise = null;
    await this.transport?.close().catch(() => undefined);
    this.transport = null;
  }

  private async getConnection(): Promise<acp.ClientSideConnection> {
    if (!this.connectionPromise) {
      this.connectionPromise = (async () => {
        const transport = new AcpStreamableHttpClientTransport(this.endpoint, {
          ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
        });
        const connection = new acp.ClientSideConnection(
          () => this.promptCaptureClient,
          transport.stream,
        );
        await connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        await transport.start();
        this.transport = transport;
        return connection;
      })();
    }

    return this.connectionPromise;
  }

  private async ensureSessionLoaded(
    connection: acp.ClientSideConnection,
    sessionId: string,
    cwd: string,
  ): Promise<void> {
    if (this.loadedSessionIds.has(sessionId)) {
      return;
    }

    await connection.loadSession({
      sessionId,
      cwd,
      mcpServers: [],
    });
    this.loadedSessionIds.add(sessionId);
  }
}

export function createFlamecastAcpEndpoint(baseUrl: string | URL, agentId: string): URL {
  return new URL(`/api/agents/${agentId}/acp`, baseUrl);
}
