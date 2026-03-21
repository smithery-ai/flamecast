import * as acp from "@agentclientprotocol/sdk";
import type { PermissionResponseBody } from "@/shared/session";
import { AcpStreamableHttpClientTransport } from "@/shared/acp-streamable-http-client";

type PendingPermissionState = {
  request: acp.RequestPermissionRequest;
  resolve: (response: acp.RequestPermissionResponse) => void;
};

export class AgentAcpClient {
  private readonly transport: AcpStreamableHttpClientTransport;
  private readonly connection: acp.ClientSideConnection;
  private readonly pendingPermissions = new Map<string, PendingPermissionState>();
  private readonly onSessionUpdate?: (params: acp.SessionNotification) => void | Promise<void>;
  private readonly onPermissionRequested?: (
    params: acp.RequestPermissionRequest,
  ) => void | Promise<void>;
  private initialized = false;

  constructor(
    agentId: string,
    opts: {
      onSessionUpdate?: (params: acp.SessionNotification) => void | Promise<void>;
      onPermissionRequested?: (params: acp.RequestPermissionRequest) => void | Promise<void>;
    } = {},
  ) {
    this.onSessionUpdate = opts.onSessionUpdate;
    this.onPermissionRequested = opts.onPermissionRequested;
    this.transport = new AcpStreamableHttpClientTransport(
      new URL(`/api/agents/${agentId}/acp`, window.location.origin),
    );
    this.connection = new acp.ClientSideConnection(
      () => this.createClientHandler(),
      this.transport.stream,
    );
  }

  async connect(): Promise<void> {
    if (this.initialized) return;

    await this.transport.start();
    await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    this.initialized = true;
  }

  async createSession(cwd = "."): Promise<acp.NewSessionResponse> {
    await this.connect();
    return this.connection.newSession({ cwd, mcpServers: [] });
  }

  async loadSession(sessionId: string, cwd: string): Promise<acp.LoadSessionResponse> {
    await this.connect();
    return this.connection.loadSession({ sessionId, cwd, mcpServers: [] });
  }

  async prompt(sessionId: string, text: string): Promise<acp.PromptResponse> {
    await this.connect();
    return this.connection.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  async respondToPermission(sessionId: string, body: PermissionResponseBody): Promise<void> {
    const pending = this.pendingPermissions.get(sessionId);
    if (!pending) {
      throw new Error("No pending permission for this session");
    }

    this.pendingPermissions.delete(sessionId);

    if ("outcome" in body && body.outcome === "cancelled") {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      return;
    }

    if (!("optionId" in body)) {
      throw new Error("Invalid permission response");
    }

    const selectedOptionId = body.optionId;
    pending.resolve({
      outcome: {
        outcome: "selected",
        optionId: selectedOptionId,
      },
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.connect();
    await this.connection.cancel({ sessionId });
  }

  async close(): Promise<void> {
    this.pendingPermissions.clear();
    await this.transport.close();
  }

  private createClientHandler(): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        await this.onSessionUpdate?.(params);
      },
      requestPermission: async (
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> =>
        new Promise((resolve) => {
          this.pendingPermissions.set(params.sessionId, { request: params, resolve });
          void this.onPermissionRequested?.(params);
        }),
      readTextFile: async (_params: acp.ReadTextFileRequest) => {
        throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.fs_read_text_file);
      },
      writeTextFile: async (_params: acp.WriteTextFileRequest) => {
        throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.fs_write_text_file);
      },
      createTerminal: async (_params: acp.CreateTerminalRequest) => {
        throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.terminal_create);
      },
      extMethod: async (method: string) => {
        throw acp.RequestError.methodNotFound(method);
      },
      extNotification: async () => undefined,
    };
  }
}
