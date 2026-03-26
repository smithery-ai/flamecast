#!/usr/bin/env node
/**
 * Minimal ACP echo agent. Responds to every prompt with a canned message
 * and a simulated tool call. Copy this file to bootstrap your own agent.
 *
 * Usage:  npx tsx agent.ts          (stdio)
 *         ACP_PORT=9000 npx tsx agent.ts  (tcp)
 */
import * as acp from "@agentclientprotocol/sdk";
import * as net from "node:net";
import { Writable } from "node:stream";

class EchoAgent implements acp.Agent {
  private connection: acp.AgentSideConnection;
  private sessions = new Map<string, { pending: AbortController | null }>();

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection;
  }

  async initialize(): Promise<acp.InitializeResponse> {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }

  async newSession(): Promise<acp.NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { pending: null });
    return { sessionId };
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async setSessionMode(): Promise<acp.SetSessionModeResponse> {
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session ${params.sessionId}`);

    session.pending?.abort();
    session.pending = new AbortController();

    // Stream a short reply word-by-word
    const words = "Hello! I received your prompt and I'm working on it.".split(" ");
    for (const word of words) {
      if (session.pending.signal.aborted) return { stopReason: "cancelled" };
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: word + " " },
        },
      });
      await new Promise((r) => setTimeout(r, 50));
    }

    // Simulate a tool call
    const toolCallId = "call_" + crypto.randomUUID().slice(0, 8);
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Reading files",
        kind: "read",
        status: "pending",
        locations: [{ path: "/workspace/README.md" }],
        rawInput: { path: "/workspace/README.md" },
      },
    });

    await new Promise((r) => setTimeout(r, 500));

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "File contents here..." } }],
        rawOutput: { content: "File contents here..." },
      },
    });

    // Final message
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "\nDone! Let me know if you need anything else." },
      },
    });

    session.pending = null;
    return { stopReason: "end_turn" };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pending?.abort();
  }
}

// --- Transport ---

function connectStdio(): void {
  const input = Writable.toWeb(process.stdout);
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      process.stdin.on("end", () => controller.close());
    },
  });
  new acp.AgentSideConnection((conn) => new EchoAgent(conn), acp.ndJsonStream(input, output));
}

function listenTcp(port: number): void {
  net
    .createServer((socket) => {
      socket.setNoDelay(true);
      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise((res, rej) => socket.write(chunk, (err) => (err ? rej(err) : res())));
        },
        close() {
          socket.end();
        },
      });
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          socket.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          socket.on("end", () => controller.close());
          socket.on("error", (err) => controller.error(err));
        },
      });
      new acp.AgentSideConnection((conn) => new EchoAgent(conn), acp.ndJsonStream(input, output));
    })
    .listen(port, () => console.error(`Agent listening on port ${port}`));
}

const acpPort = process.env.ACP_PORT ? parseInt(process.env.ACP_PORT, 10) : undefined;
if (acpPort) listenTcp(acpPort);
else connectStdio();
