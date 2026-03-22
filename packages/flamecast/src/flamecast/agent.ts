#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import * as net from "node:net";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

interface AgentSession {
  appliedEditCount: number;
  nextToolCallIndex: number;
  pendingPrompt: AbortController | null;
  proposalPath: string;
}

export class ExampleAgent implements acp.Agent {
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

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    this.sessions.set(sessionId, {
      appliedEditCount: 0,
      nextToolCallIndex: 1,
      pendingPrompt: null,
      proposalPath: join(params.cwd, `.flamecast-agent-edit-${sessionId}.md`),
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
      await this.simulateTurn(
        params.sessionId,
        this.getPromptText(params.prompt),
        session,
        session.pendingPrompt.signal,
      );
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

  private async simulateTurn(
    sessionId: string,
    promptText: string,
    session: AgentSession,
    abortSignal: AbortSignal,
  ): Promise<void> {
    await this.streamAgentMessageChunks(
      sessionId,
      "I'll help you with that. Let me start by reading some files to understand the current situation.",
      abortSignal,
    );

    await this.simulateModelInteraction(abortSignal);

    const readToolCallId = this.nextToolCallId(session);
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: readToolCallId,
        title: "Inspecting the current proposal file",
        kind: "read",
        status: "pending",
        locations: [{ path: session.proposalPath }],
        rawInput: { path: session.proposalPath },
      },
    });

    await this.simulateModelInteraction(abortSignal);

    const existingContent = await this.readExistingProposal(sessionId, session.proposalPath);
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: readToolCallId,
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text:
                existingContent ??
                "No existing proposal file was found. The next approved edit will create it.",
            },
          },
        ],
        rawOutput: {
          content: existingContent,
          exists: existingContent !== null,
          path: session.proposalPath,
        },
      },
    });

    await this.simulateModelInteraction(abortSignal);

    await this.streamAgentMessageChunks(
      sessionId,
      " Now I understand the project structure. I need to make some changes to improve it.",
      abortSignal,
    );

    await this.simulateModelInteraction(abortSignal);

    const proposedDiff = this.buildProposedDiff(session, promptText, existingContent);
    const editToolCallId = this.nextToolCallId(session);
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: editToolCallId,
        title: "Preparing a real workspace edit",
        kind: "edit",
        status: "pending",
        locations: [{ path: proposedDiff.path }],
        content: [{ type: "diff", ...proposedDiff }],
        rawInput: {
          path: proposedDiff.path,
          oldText: proposedDiff.oldText ?? null,
          newText: proposedDiff.newText,
        },
      },
    });

    const permissionResponse = await this.connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: editToolCallId,
        title: "Preparing a real workspace edit",
        kind: "edit",
        status: "pending",
        locations: [{ path: proposedDiff.path }],
        content: [{ type: "diff", ...proposedDiff }],
        rawInput: {
          path: proposedDiff.path,
          oldText: proposedDiff.oldText ?? null,
          newText: proposedDiff.newText,
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
            toolCallId: editToolCallId,
            status: "in_progress",
          },
        });

        await this.connection.writeTextFile({
          sessionId,
          path: proposedDiff.path,
          content: proposedDiff.newText,
        });
        session.appliedEditCount += 1;

        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: editToolCallId,
            status: "completed",
            content: [{ type: "diff", ...proposedDiff }],
            rawOutput: {
              path: proposedDiff.path,
              success: true,
              bytesWritten: proposedDiff.newText.length,
            },
          },
        });

        await this.simulateModelInteraction(abortSignal);

        await this.streamAgentMessageChunks(
          sessionId,
          ` Perfect! I've written the approved edit to ${proposedDiff.path}.`,
          abortSignal,
        );
        break;
      }
      case "reject": {
        await this.simulateModelInteraction(abortSignal);

        await this.streamAgentMessageChunks(
          sessionId,
          " I understand you prefer not to make that change. I'll skip the workspace edit.",
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
    let chunks: string[];
    if (wordChunks) {
      chunks = wordChunks;
    } else if (text.length > 0) {
      const characters = Array.from(text);
      chunks = [];
      for (let i = 0; i < characters.length; i += 4) {
        chunks.push(characters.slice(i, i + 4).join(""));
      }
    } else {
      chunks = [];
    }

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
    if (abortSignal.aborted) {
      return Promise.reject(new Error("aborted"));
    }

    const ms = 35 + Math.floor(Math.random() * 55);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(t);
        abortSignal.removeEventListener("abort", onAbort);
        reject(new Error("aborted"));
      };
      const t = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort);
        if (abortSignal.aborted) {
          reject(new Error("aborted"));
        } else {
          resolve();
        }
      }, ms);
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private getPromptText(prompt: acp.PromptRequest["prompt"]): string {
    const textParts = prompt.flatMap((item) =>
      item.type === "text" && item.text.trim().length > 0 ? [item.text.trim()] : [],
    );
    return textParts.join("\n\n");
  }

  private nextToolCallId(session: AgentSession): string {
    const toolCallId = `call_${session.nextToolCallIndex}`;
    session.nextToolCallIndex += 1;
    return toolCallId;
  }

  private async readExistingProposal(sessionId: string, path: string): Promise<string | null> {
    try {
      const response = await this.connection.readTextFile({ sessionId, path });
      return response.content;
    } catch {
      return null;
    }
  }

  private buildProposedDiff(
    session: AgentSession,
    promptText: string,
    oldText: string | null,
  ): acp.Diff {
    const nextUpdateNumber = session.appliedEditCount + 1;
    const normalizedPrompt = promptText.trim() || "No prompt text was provided.";
    const newText = oldText
      ? `${oldText.trimEnd()}\n\n## Update ${nextUpdateNumber}\n\n${normalizedPrompt}\n`
      : [
          "# Flamecast Approval Demo",
          "",
          "This file is created and updated only after you approve the proposed edit.",
          "",
          `## Update ${nextUpdateNumber}`,
          "",
          normalizedPrompt,
          "",
        ].join("\n");

    return {
      path: session.proposalPath,
      oldText,
      newText,
    };
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

export function toUint8ReadableStream(
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

export function connectStdio(): void {
  const input = Writable.toWeb(process.stdout);
  const output = toUint8ReadableStream(Readable.toWeb(process.stdin));
  const stream = acp.ndJsonStream(input, output);
  new acp.AgentSideConnection((conn) => new ExampleAgent(conn), stream);
}

export async function listenTcp(port: number): Promise<void> {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true); // Disable Nagle — NDJSON needs immediate flush
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

export function main(): void {
  const acpPort = process.env.ACP_PORT ? parseInt(process.env.ACP_PORT, 10) : undefined;
  if (acpPort) {
    void listenTcp(acpPort);
  } else {
    connectStdio();
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  main();
}
