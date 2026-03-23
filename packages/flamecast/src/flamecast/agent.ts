#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { unlink } from "node:fs/promises";
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

        await this.simulateModelInteraction(abortSignal);

        let currentFileText = proposedDiff.newText;

        const appendLineEdit = this.buildAppendLineEdit(
          proposedDiff.path,
          currentFileText,
          promptText,
        );
        const appendToolCallId = this.nextToolCallId(session);
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: appendToolCallId,
            title: "Add a line to the existing demo file",
            kind: "edit",
            status: "pending",
            locations: [{ path: appendLineEdit.previewDiff.path }],
            content: [{ type: "diff", ...appendLineEdit.previewDiff }],
            rawInput: {
              path: appendLineEdit.previewDiff.path,
              content: appendLineEdit.newText,
            },
          },
        });

        const appendPermission = await this.connection.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: appendToolCallId,
            title: "Add a line to the existing demo file",
            kind: "edit",
            status: "pending",
            locations: [{ path: appendLineEdit.previewDiff.path }],
            content: [{ type: "diff", ...appendLineEdit.previewDiff }],
            rawInput: {
              path: appendLineEdit.previewDiff.path,
              content: appendLineEdit.newText,
            },
          },
          options: [
            {
              kind: "allow_once",
              name: "Add the line",
              optionId: "allow",
            },
            {
              kind: "reject_once",
              name: "Skip this edit",
              optionId: "reject",
            },
          ],
        });

        if (appendPermission.outcome.outcome === "cancelled") {
          return;
        }

        if (appendPermission.outcome.optionId === "allow") {
          await this.connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: appendToolCallId,
              status: "in_progress",
            },
          });

          await this.connection.writeTextFile({
            sessionId,
            path: appendLineEdit.previewDiff.path,
            content: appendLineEdit.newText,
          });
          currentFileText = appendLineEdit.newText;

          await this.connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: appendToolCallId,
              status: "completed",
              content: [{ type: "diff", ...appendLineEdit.previewDiff }],
              rawOutput: {
                path: appendLineEdit.previewDiff.path,
                success: true,
                bytesWritten: appendLineEdit.newText.length,
              },
            },
          });

          await this.simulateModelInteraction(abortSignal);

          await this.streamAgentMessageChunks(
            sessionId,
            " I added a single extra line to that existing file and only showed the changed tail in the diff preview.",
            abortSignal,
          );

          await this.simulateModelInteraction(abortSignal);

          const undoLineEdit = this.buildUndoLineEdit(
            appendLineEdit.previewDiff.path,
            currentFileText,
            proposedDiff.newText,
          );
          const undoToolCallId = this.nextToolCallId(session);
          await this.connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: undoToolCallId,
              title: "Undo the extra line change",
              kind: "edit",
              status: "pending",
              locations: [{ path: undoLineEdit.previewDiff.path }],
              content: [{ type: "diff", ...undoLineEdit.previewDiff }],
              rawInput: {
                path: undoLineEdit.previewDiff.path,
                content: undoLineEdit.newText,
              },
            },
          });

          const undoPermission = await this.connection.requestPermission({
            sessionId,
            toolCall: {
              toolCallId: undoToolCallId,
              title: "Undo the extra line change",
              kind: "edit",
              status: "pending",
              locations: [{ path: undoLineEdit.previewDiff.path }],
              content: [{ type: "diff", ...undoLineEdit.previewDiff }],
              rawInput: {
                path: undoLineEdit.previewDiff.path,
                content: undoLineEdit.newText,
              },
            },
            options: [
              {
                kind: "allow_once",
                name: "Undo the line",
                optionId: "allow",
              },
              {
                kind: "reject_once",
                name: "Keep the line",
                optionId: "reject",
              },
            ],
          });

          if (undoPermission.outcome.outcome === "cancelled") {
            return;
          }

          if (undoPermission.outcome.optionId === "allow") {
            await this.connection.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: undoToolCallId,
                status: "in_progress",
              },
            });

            await this.connection.writeTextFile({
              sessionId,
              path: undoLineEdit.previewDiff.path,
              content: undoLineEdit.newText,
            });
            currentFileText = undoLineEdit.newText;

            await this.connection.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: undoToolCallId,
                status: "completed",
                content: [{ type: "diff", ...undoLineEdit.previewDiff }],
                rawOutput: {
                  path: undoLineEdit.previewDiff.path,
                  success: true,
                  bytesWritten: undoLineEdit.newText.length,
                },
              },
            });

            await this.simulateModelInteraction(abortSignal);

            await this.streamAgentMessageChunks(
              sessionId,
              " I then prepared and applied a second edit that undid just that extra line.",
              abortSignal,
            );
          } else if (undoPermission.outcome.optionId === "reject") {
            await this.simulateModelInteraction(abortSignal);

            await this.streamAgentMessageChunks(
              sessionId,
              " I kept the extra line because the undo step was rejected.",
              abortSignal,
            );
          } else {
            throw new Error(`Unexpected permission outcome ${undoPermission.outcome}`);
          }
        } else if (appendPermission.outcome.optionId === "reject") {
          await this.simulateModelInteraction(abortSignal);

          await this.streamAgentMessageChunks(
            sessionId,
            " I skipped the follow-up line edit because that step was rejected.",
            abortSignal,
          );
        } else {
          throw new Error(`Unexpected permission outcome ${appendPermission.outcome}`);
        }

        await this.simulateModelInteraction(abortSignal);

        const deleteDiff = this.buildDeleteDiff(proposedDiff.path, currentFileText);
        const deleteToolCallId = this.nextToolCallId(session);
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: deleteToolCallId,
            title: "cleanup",
            kind: "other",
            status: "pending",
            locations: [{ path: deleteDiff.path }],
            content: [{ type: "diff", ...deleteDiff }],
            rawInput: {
              path: deleteDiff.path,
              oldText: deleteDiff.oldText,
              newText: deleteDiff.newText,
            },
          },
        });

        const deletePermission = await this.connection.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: deleteToolCallId,
            title: "cleanup",
            kind: "other",
            status: "pending",
            locations: [{ path: deleteDiff.path }],
            content: [{ type: "diff", ...deleteDiff }],
            rawInput: {
              path: deleteDiff.path,
              oldText: deleteDiff.oldText,
              newText: deleteDiff.newText,
            },
          },
          options: [
            {
              kind: "allow_once",
              name: "Delete the file",
              optionId: "allow",
            },
            {
              kind: "reject_once",
              name: "Keep the file",
              optionId: "reject",
            },
          ],
        });

        if (deletePermission.outcome.outcome === "cancelled") {
          return;
        }

        switch (deletePermission.outcome.optionId) {
          case "allow": {
            await this.connection.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: deleteToolCallId,
                status: "in_progress",
              },
            });

            await unlink(deleteDiff.path);

            await this.connection.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: deleteToolCallId,
                status: "completed",
                content: [{ type: "diff", ...deleteDiff }],
                rawOutput: {
                  path: deleteDiff.path,
                  success: true,
                  deleted: true,
                },
              },
            });

            await this.simulateModelInteraction(abortSignal);

            await this.streamAgentMessageChunks(
              sessionId,
              " I also deleted the temporary demo file after the approved cleanup step.",
              abortSignal,
            );
            break;
          }
          case "reject": {
            await this.simulateModelInteraction(abortSignal);

            await this.streamAgentMessageChunks(
              sessionId,
              " I left the temporary demo file in place because the cleanup step was rejected.",
              abortSignal,
            );
            break;
          }
          default:
            throw new Error(`Unexpected permission outcome ${deletePermission.outcome}`);
        }
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

  private buildAppendLineEdit(
    path: string,
    oldText: string,
    promptText: string,
  ): { newText: string; previewDiff: acp.Diff } {
    const line = this.buildExtraLine(promptText);
    const newText = `${oldText.endsWith("\n") ? oldText : `${oldText}\n`}${line}\n`;

    return {
      newText,
      previewDiff: this.buildPartialTailDiff(path, oldText, newText),
    };
  }

  private buildUndoLineEdit(
    path: string,
    oldText: string,
    newText: string,
  ): { newText: string; previewDiff: acp.Diff } {
    return {
      newText,
      previewDiff: this.buildPartialTailDiff(path, oldText, newText),
    };
  }

  private buildDeleteDiff(path: string, oldText: string): acp.Diff {
    return {
      path,
      oldText,
      newText: "",
    };
  }

  private buildExtraLine(promptText: string): string {
    const normalized = promptText.replace(/\s+/g, " ").trim() || "No prompt text was provided.";
    const summary = normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
    return `- Extra line: ${summary}`;
  }

  private buildPartialTailDiff(path: string, oldText: string, newText: string): acp.Diff {
    return {
      path,
      oldText: this.takeTrailingLines(oldText, 4),
      newText: this.takeTrailingLines(newText, 5),
    };
  }

  private takeTrailingLines(text: string, maxLines: number): string {
    const lines = text.split("\n");
    if (text.endsWith("\n")) {
      lines.pop();
    }

    const tail = lines.slice(-maxLines);
    return tail.length > 0 ? `${tail.join("\n")}\n` : "";
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
