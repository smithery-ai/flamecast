import { randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { EventEmitter } from "node:events";
import * as acp from "@agentclientprotocol/sdk";
import type { PendingPermission } from "../shared/session.js";
import type { AcpTransport } from "../flamecast/transport.js";

// ---- Event types emitted by AcpBridge ----

export type RpcEventData = {
  method: string;
  direction: "client_to_agent" | "agent_to_client";
  phase: "request" | "response" | "notification";
  payload?: unknown;
};

export type PermissionRequestEventData = {
  pendingPermission: PendingPermission;
};

export type LogEventData = {
  type: string;
  data: Record<string, unknown>;
};

export interface AcpBridgeEvents {
  rpc: [RpcEventData];
  permissionRequest: [PermissionRequestEventData];
  log: [LogEventData];
}

// ---- Text chunk coalescing buffer ----

type StreamingTextChunkKind = "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk";

interface TextChunkBuffer {
  sessionId: string;
  kind: StreamingTextChunkKind;
  messageId: string | null;
  texts: string[];
}

// ---- Permission resolver ----

type PermissionResolver = (response: acp.RequestPermissionResponse) => void;

/**
 * AcpBridge wraps an ACP ClientSideConnection and provides the acp.Client
 * implementation. It emits typed events for RPC calls, permission requests,
 * and log entries instead of directly interacting with storage.
 *
 * This is the unit that will eventually become the sidecar process.
 */
export class AcpBridge extends EventEmitter<AcpBridgeEvents> {
  private connection: acp.ClientSideConnection | null = null;
  private textChunkBuffer: TextChunkBuffer | null = null;
  private readonly permissionResolvers = new Map<string, PermissionResolver>();

  constructor(
    private readonly transport: AcpTransport,
    private readonly workspaceRoot: string,
  ) {
    super();
  }

  /** Initialize the ACP connection and return the init result. */
  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    const stream = acp.ndJsonStream(this.transport.input, this.transport.output);
    const client = this.createClient();
    this.connection = new acp.ClientSideConnection((_agent) => client, stream);

    this.emitRpc(acp.AGENT_METHODS.initialize, "client_to_agent", "request", params);
    const result = await this.connection.initialize(params);
    this.emitRpc(acp.AGENT_METHODS.initialize, "agent_to_client", "response", result);
    return result;
  }

  /** Create a new ACP session. */
  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    if (!this.connection) throw new Error("Not initialized");
    this.emitRpc(acp.AGENT_METHODS.session_new, "client_to_agent", "request", params);
    const result = await this.connection.newSession(params);
    this.emitRpc(acp.AGENT_METHODS.session_new, "agent_to_client", "response", result);
    return result;
  }

  /** Send a prompt to the agent. */
  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    if (!this.connection) throw new Error("Not initialized");
    this.emitRpc(acp.AGENT_METHODS.session_prompt, "client_to_agent", "request", params);
    try {
      const result = await this.connection.prompt(params);
      await this.flush();
      this.emitRpc(acp.AGENT_METHODS.session_prompt, "agent_to_client", "response", result);
      return result;
    } catch (error) {
      await this.flush();
      throw error;
    }
  }

  /**
   * Resolve a pending permission request.
   * Called by the owner (LocalRuntimeClient) when the user responds.
   */
  resolvePermission(requestId: string, response: acp.RequestPermissionResponse): void {
    const resolver = this.permissionResolvers.get(requestId);
    if (!resolver) {
      throw new Error(`No pending permission for requestId "${requestId}"`);
    }
    this.permissionResolvers.delete(requestId);
    this.emitRpc(
      acp.CLIENT_METHODS.session_request_permission,
      "client_to_agent",
      "response",
      response,
    );
    resolver(response);
  }

  /** Flush any buffered text chunks as a coalesced RPC event. */
  async flush(): Promise<void> {
    const buffer = this.textChunkBuffer;
    if (!buffer || buffer.texts.length === 0) {
      this.textChunkBuffer = null;
      return;
    }
    this.textChunkBuffer = null;

    let combined: string;
    try {
      combined = buffer.texts.join("");
    } catch (error) {
      this.emit("log", {
        type: "rpc_coalesce_error",
        data: {
          reason: "join_failed",
          message: error instanceof Error ? error.message : String(error),
          partialParts: buffer.texts.length,
        },
      });
      for (const text of buffer.texts) {
        this.emitRpc(acp.CLIENT_METHODS.session_update, "agent_to_client", "notification", {
          sessionId: buffer.sessionId,
          update: {
            sessionUpdate: buffer.kind,
            content: { type: "text", text },
            ...(buffer.messageId != null ? { messageId: buffer.messageId } : {}),
          },
        });
      }
      return;
    }

    const update = {
      sessionUpdate: buffer.kind,
      content: { type: "text" as const, text: combined },
      ...(buffer.messageId != null ? { messageId: buffer.messageId } : {}),
    } satisfies acp.SessionUpdate;

    this.emitRpc(acp.CLIENT_METHODS.session_update, "agent_to_client", "notification", {
      sessionId: buffer.sessionId,
      update,
    });
  }

  /** Whether the bridge has been initialized. */
  get isInitialized(): boolean {
    return this.connection !== null;
  }

  // ---- Private: ACP Client implementation ----

  private createClient(): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        await this.handleSessionUpdate(params);
      },

      requestPermission: async (
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> => {
        this.emitRpc(
          acp.CLIENT_METHODS.session_request_permission,
          "agent_to_client",
          "request",
          params,
        );

        const pendingPermission = this.createPendingPermission(params);

        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          this.permissionResolvers.set(pendingPermission.requestId, resolve);
          this.emit("permissionRequest", { pendingPermission });
        });
      },

      readTextFile: async (params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> => {
        this.emitRpc(acp.CLIENT_METHODS.fs_read_text_file, "agent_to_client", "request", params);
        const absolutePath = await this.resolveAbsoluteReadPath(params.path);
        const content = await readFile(absolutePath, "utf8");
        const lines = content.split("\n");
        const startLine = Math.max(params.line ?? 0, 0);
        const limitedLines =
          params.limit != null
            ? lines.slice(startLine, startLine + params.limit)
            : lines.slice(startLine);
        const response: acp.ReadTextFileResponse = { content: limitedLines.join("\n") };
        this.emitRpc(acp.CLIENT_METHODS.fs_read_text_file, "client_to_agent", "response", response);
        return response;
      },

      writeTextFile: async (
        params: acp.WriteTextFileRequest,
      ): Promise<acp.WriteTextFileResponse> => {
        this.emitRpc(acp.CLIENT_METHODS.fs_write_text_file, "agent_to_client", "request", params);
        const absolutePath = await this.resolveAbsoluteWritePath(params.path);
        await writeFile(absolutePath, params.content, "utf8");
        const response: acp.WriteTextFileResponse = {};
        this.emitRpc(
          acp.CLIENT_METHODS.fs_write_text_file,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      createTerminal: async (
        params: acp.CreateTerminalRequest,
      ): Promise<acp.CreateTerminalResponse> => {
        this.emitRpc(acp.CLIENT_METHODS.terminal_create, "agent_to_client", "request", params);
        const response: acp.CreateTerminalResponse = { terminalId: `stub-${randomUUID()}` };
        this.emitRpc(acp.CLIENT_METHODS.terminal_create, "client_to_agent", "response", response);
        return response;
      },

      terminalOutput: async (
        params: acp.TerminalOutputRequest,
      ): Promise<acp.TerminalOutputResponse> => {
        this.emitRpc(acp.CLIENT_METHODS.terminal_output, "agent_to_client", "request", params);
        const response: acp.TerminalOutputResponse = { output: "", truncated: false };
        this.emitRpc(acp.CLIENT_METHODS.terminal_output, "client_to_agent", "response", response);
        return response;
      },

      releaseTerminal: async (
        params: acp.ReleaseTerminalRequest,
      ): Promise<acp.ReleaseTerminalResponse | void> => {
        this.emitRpc(acp.CLIENT_METHODS.terminal_release, "agent_to_client", "request", params);
        const response: acp.ReleaseTerminalResponse = {};
        this.emitRpc(acp.CLIENT_METHODS.terminal_release, "client_to_agent", "response", response);
        return response;
      },

      waitForTerminalExit: async (
        params: acp.WaitForTerminalExitRequest,
      ): Promise<acp.WaitForTerminalExitResponse> => {
        this.emitRpc(
          acp.CLIENT_METHODS.terminal_wait_for_exit,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.WaitForTerminalExitResponse = { exitCode: 0 };
        this.emitRpc(
          acp.CLIENT_METHODS.terminal_wait_for_exit,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      killTerminal: async (
        params: acp.KillTerminalRequest,
      ): Promise<acp.KillTerminalResponse | void> => {
        this.emitRpc(acp.CLIENT_METHODS.terminal_kill, "agent_to_client", "request", params);
        const response: acp.KillTerminalResponse = {};
        this.emitRpc(acp.CLIENT_METHODS.terminal_kill, "client_to_agent", "response", response);
        return response;
      },

      extMethod: async (
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        this.emitRpc(method, "agent_to_client", "request", params);
        throw acp.RequestError.methodNotFound(method);
      },

      extNotification: async (method: string, params: Record<string, unknown>): Promise<void> => {
        this.emitRpc(method, "agent_to_client", "notification", params);
      },
    };
  }

  // ---- Private: Text chunk coalescing ----

  private async handleSessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    if (
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "user_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk") &&
      update.content.type === "text" &&
      typeof update.content.text === "string"
    ) {
      const kind = update.sessionUpdate;
      const messageId = update.messageId ?? null;
      const buffer = this.textChunkBuffer;

      if (
        buffer &&
        (buffer.sessionId !== params.sessionId ||
          buffer.kind !== kind ||
          (buffer.messageId ?? null) !== messageId)
      ) {
        await this.flush();
      }

      const next = this.textChunkBuffer;
      if (next) {
        next.texts.push(update.content.text);
      } else {
        this.textChunkBuffer = {
          sessionId: params.sessionId,
          kind,
          messageId,
          texts: [update.content.text],
        };
      }
      return;
    }

    await this.flush();
    this.emitRpc(acp.CLIENT_METHODS.session_update, "agent_to_client", "notification", params);
  }

  // ---- Private: Permission helpers ----

  private createPendingPermission(params: acp.RequestPermissionRequest): PendingPermission {
    return {
      requestId: randomUUID(),
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "",
      kind: params.toolCall.kind ?? undefined,
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: String(option.kind),
      })),
    };
  }

  // ---- Private: File path resolution ----

  private async resolveAbsoluteReadPath(path: string): Promise<string> {
    if (!isAbsolute(path)) {
      throw new Error(`File paths must be absolute: "${path}"`);
    }
    const realPath = await realpath(path);
    const rel = relative(this.workspaceRoot, realPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path "${path}" is outside workspace root`);
    }
    return realPath;
  }

  private async resolveAbsoluteWritePath(path: string): Promise<string> {
    if (!isAbsolute(path)) {
      throw new Error(`File paths must be absolute: "${path}"`);
    }
    const requestedPath = resolve(path);
    const rel = relative(this.workspaceRoot, requestedPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path "${path}" is outside workspace root`);
    }
    return requestedPath;
  }

  // ---- Private: Event emission helpers ----

  private emitRpc(
    method: string,
    direction: "client_to_agent" | "agent_to_client",
    phase: "request" | "response" | "notification",
    payload?: unknown,
  ): void {
    this.emit("rpc", { method, direction, phase, payload });
  }
}
