#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

interface AgentSession {
  pendingPrompt: AbortController | null;
}

class ExampleAgent implements acp.Agent {
  private connection: acp.AgentSideConnection;
  private sessions: Map<string, AgentSession>;

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection;
    this.sessions = new Map();
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    this.sessions.set(sessionId, {
      pendingPrompt: null,
    });

    return {
      sessionId,
    };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse | void> {
    // No auth needed - return empty response
    return {};
  }

  async setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    // Session mode changes not implemented in this example
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);

    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();

    try {
      await this.simulateTurn(params.sessionId, session.pendingPrompt.signal);
    } catch (err) {
      if (session.pendingPrompt.signal.aborted) {
        return { stopReason: "cancelled" };
      }

      throw err;
    }

    session.pendingPrompt = null;

    return {
      stopReason: "end_turn",
    };
  }

  private async simulateTurn(sessionId: string, abortSignal: AbortSignal): Promise<void> {
    await this.streamAgentMessageChunks(
      sessionId,
      "I'll help you with that. Let me start by reading some files to understand the current situation.",
      abortSignal,
    );

    await this.simulateModelInteraction(abortSignal);

    // Send a tool call that doesn't need permission
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Reading project files",
        kind: "read",
        status: "pending",
        locations: [{ path: "/project/README.md" }],
        rawInput: { path: "/project/README.md" },
      },
    });

    await this.simulateModelInteraction(abortSignal);

    // Update tool call to completed
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "# My Project\n\nThis is a sample project...",
            },
          },
        ],
        rawOutput: { content: "# My Project\n\nThis is a sample project..." },
      },
    });

    await this.simulateModelInteraction(abortSignal);

    await this.streamAgentMessageChunks(
      sessionId,
      " Now I understand the project structure. I need to make some changes to improve it.",
      abortSignal,
    );

    await this.simulateModelInteraction(abortSignal);

    // Send a tool call that DOES need permission
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_2",
        title: "Modifying critical configuration file",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/project/config.json" }],
        rawInput: {
          path: "/project/config.json",
          content: '{"database": {"host": "new-host"}}',
        },
      },
    });

    // Request permission for the sensitive operation
    const permissionResponse = await this.connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: "call_2",
        title: "Modifying critical configuration file",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/home/user/project/config.json" }],
        rawInput: {
          path: "/home/user/project/config.json",
          content: '{"database": {"host": "new-host"}}',
        },
      },
      options: [
        {
          kind: "allow_once",
          name: "Allow this change",
          optionId: "allow",
        },
        {
          kind: "reject_once",
          name: "Skip this change",
          optionId: "reject",
        },
      ],
    });

    if (permissionResponse.outcome.outcome === "cancelled") {
      return;
    }

    switch (permissionResponse.outcome.optionId) {
      case "allow": {
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_2",
            status: "completed",
            rawOutput: { success: true, message: "Configuration updated" },
          },
        });

        await this.simulateModelInteraction(abortSignal);

        await this.streamAgentMessageChunks(
          sessionId,
          " Perfect! I've successfully updated the configuration. The changes have been applied.",
          abortSignal,
        );
        break;
      }
      case "reject": {
        await this.simulateModelInteraction(abortSignal);

        await this.streamAgentMessageChunks(
          sessionId,
          " I understand you prefer not to make that change. I'll skip the configuration update.",
          abortSignal,
        );
        break;
      }
      default:
        throw new Error(`Unexpected permission outcome ${permissionResponse.outcome}`);
    }
  }

  /** Sends text as many small `agent_message_chunk` updates with brief delays (LLM-style streaming). */
  private async streamAgentMessageChunks(
    sessionId: string,
    text: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const wordChunks = text.match(/\s*\S+\s*/g);
    const chunks = wordChunks ?? (text.length > 0 ? (text.match(/.{1,4}/gu) ?? [text]) : []);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (abortSignal.aborted) {
        throw new Error("aborted");
      }
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        },
      });
      if (i < chunks.length - 1) {
        await this.delayBetweenStreamChunks(abortSignal);
      }
    }
  }

  private delayBetweenStreamChunks(abortSignal: AbortSignal): Promise<void> {
    const ms = 35 + Math.floor(Math.random() * 55);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (abortSignal.aborted) {
          reject(new Error("aborted"));
        } else {
          resolve();
        }
      }, ms);
      abortSignal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  }

  private simulateModelInteraction(abortSignal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        // In a real agent, you'd pass this abort signal to the LLM client
        if (abortSignal.aborted) {
          reject();
        } else {
          resolve();
        }
      }, 1000),
    );
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }
}

function toUint8ReadableStream(
  stream: ReturnType<typeof Readable.toWeb>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const reader = stream.getReader();
      function pump(): Promise<void> {
        return reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
          return pump();
        });
      }
      pump();
    },
  });
}

function connectStdio(): void {
  const input = Writable.toWeb(process.stdout);
  const output = toUint8ReadableStream(Readable.toWeb(process.stdin));
  const stream = acp.ndJsonStream(input, output);
  new acp.AgentSideConnection((conn) => new ExampleAgent(conn), stream);
}

async function listenTcp(port: number): Promise<void> {
  const net = await import("node:net");
  const server = net.createServer((socket) => {
    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise((res, rej) => {
          socket.write(chunk, (err) => (err ? rej(err) : res()));
        });
      },
      close() {
        socket.end();
      },
    });

    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        socket.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        socket.on("end", () => controller.close());
        socket.on("error", (err) => controller.error(err));
      },
    });

    const stream = acp.ndJsonStream(input, output);
    new acp.AgentSideConnection((conn) => new ExampleAgent(conn), stream);
  });
  server.listen(port, () => {
    console.error(`Agent listening on port ${port}`);
  });
}

const acpPort = process.env.ACP_PORT ? parseInt(process.env.ACP_PORT, 10) : undefined;
if (acpPort) {
  listenTcp(acpPort);
} else {
  connectStdio();
}
