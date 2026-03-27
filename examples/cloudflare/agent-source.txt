#!/usr/bin/env node
/**
 * Minimal ACP echo agent. Responds to every prompt with a canned message
 * and a simulated tool call. Copy this file to bootstrap your own agent.
 *
 * Usage:  npx tsx agent.ts          (stdio)
 *         ACP_PORT=9000 npx tsx agent.ts  (tcp)
 */
import * as acp from "@agentclientprotocol/sdk";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { Writable } from "node:stream";

// ---------------------------------------------------------------------------
// Lorem ipsum helpers
// ---------------------------------------------------------------------------

const LOREM_LINES = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
  "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
  "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
  "Nisi ut aliquip ex ea commodo consequat.",
  "Duis aute irure dolor in reprehenderit in voluptate velit esse.",
  "Cillum dolore eu fugiat nulla pariatur.",
  "Excepteur sint occaecat cupidatat non proident.",
  "Sunt in culpa qui officia deserunt mollit anim id est laborum.",
  "Vivamus lacinia odio vitae vestibulum vestibulum.",
  "Praesent commodo cursus magna, vel scelerisque nisl consectetur.",
];

function generateLoremIpsum(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(LOREM_LINES[i % LOREM_LINES.length]);
  }
  return out.join("\n") + "\n";
}

const BOILERPLATE =
  [
    "# ========================================",
    "# BOILERPLATE SECTION — auto-generated",
    "# ========================================",
    "export const APP_NAME = 'LoremApp';",
    "export const APP_VERSION = '0.1.0';",
    "export const DEFAULT_LOCALE = 'en-US';",
    "export const MAX_RETRIES = 3;",
    "export const TIMEOUT_MS = 5000;",
    "# ========================================",
    "# END BOILERPLATE",
    "# ========================================",
  ].join("\n") + "\n";

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class EchoAgent implements acp.Agent {
  private connection: acp.AgentSideConnection;
  private sessions = new Map<string, { pending: AbortController | null; cwd: string }>();

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection;
  }

  async initialize(): Promise<acp.InitializeResponse> {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { pending: null, cwd: params.cwd ?? process.cwd() });

    // Advertise available slash commands to the client
    void this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "help", description: "Show available commands" },
          { name: "status", description: "Show current session status" },
          {
            name: "search",
            description: "Search for files in the workspace",
            input: { type: "unstructured", hint: "search query" },
          },
        ],
      },
    });

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
    const signal = session.pending.signal;

    const sid = params.sessionId;
    const loremContent = generateLoremIpsum(100);

    // Helper: create a file with a tool call + permission request
    const createFile = async (name: string): Promise<boolean> => {
      const filePath = path.join(session.cwd, name);
      const callId = "call_" + crypto.randomUUID().slice(0, 8);
      const relPath = "./" + name;

      await this.connection.sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: callId,
          title: `Create ${name}`,
          kind: "edit",
          status: "pending",
          locations: [{ path: relPath }],
          rawInput: { path: relPath, content: loremContent },
        },
      });

      const perm = await this.connection.requestPermission({
        sessionId: sid,
        toolCall: {
          toolCallId: callId,
          title: `Create ${name}`,
          kind: "edit",
          status: "pending",
          locations: [{ path: relPath }],
          rawInput: { path: relPath, content: loremContent },
        },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      });

      if (perm.outcome.outcome === "cancelled" || perm.outcome.optionId === "reject") {
        await this.connection.sessionUpdate({
          sessionId: sid,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            status: "completed",
            rawOutput: { success: false, message: `User rejected creation of ${name}` },
          },
        });
        return false;
      }

      await fs.writeFile(filePath, loremContent, "utf8");
      await this.connection.sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: loremContent } }],
          rawOutput: { success: true, message: `Created ${name} with 100 lines` },
        },
      });
      return true;
    };

    // Helper: edit a file (insert boilerplate at midpoint)
    const editFile = async (name: string): Promise<boolean> => {
      const filePath = path.join(session.cwd, name);
      const callId = "call_" + crypto.randomUUID().slice(0, 8);
      const relPath = "./" + name;

      const lines = loremContent.split("\n");
      const midpoint = Math.floor(lines.length / 2);
      const boilerplateLines = BOILERPLATE.split("\n");
      lines.splice(midpoint, 0, ...boilerplateLines);
      const editedContent = lines.join("\n");

      await this.connection.sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: callId,
          title: `Insert boilerplate into ${name}`,
          kind: "edit",
          status: "pending",
          locations: [{ path: relPath }],
          rawInput: { path: relPath, insertAtLine: midpoint, content: BOILERPLATE },
        },
      });

      const perm = await this.connection.requestPermission({
        sessionId: sid,
        toolCall: {
          toolCallId: callId,
          title: `Insert boilerplate into ${name}`,
          kind: "edit",
          status: "pending",
          locations: [{ path: relPath }],
          rawInput: { path: relPath, insertAtLine: midpoint, content: BOILERPLATE },
        },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      });

      if (perm.outcome.outcome === "cancelled" || perm.outcome.optionId === "reject") {
        await this.connection.sessionUpdate({
          sessionId: sid,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            status: "completed",
            rawOutput: { success: false, message: `User rejected edit of ${name}` },
          },
        });
        return false;
      }

      await fs.writeFile(filePath, editedContent, "utf8");
      await this.connection.sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: editedContent } }],
          rawOutput: {
            success: true,
            message: `Inserted boilerplate into ${name} at line ${midpoint}`,
          },
        },
      });
      return true;
    };

    // Helper: delete a file
    const deleteFile = async (name: string): Promise<boolean> => {
      const filePath = path.join(session.cwd, name);
      const callId = "call_" + crypto.randomUUID().slice(0, 8);
      const relPath = "./" + name;

      await this.connection.sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: callId,
          title: `Delete ${name}`,
          kind: "edit",
          status: "pending",
          locations: [{ path: relPath }],
          rawInput: { path: relPath, action: "delete" },
        },
      });

      const perm = await this.connection.requestPermission({
        sessionId: sid,
        toolCall: {
          toolCallId: callId,
          title: `Delete ${name}`,
          kind: "edit",
          status: "pending",
          locations: [{ path: relPath }],
          rawInput: { path: relPath, action: "delete" },
        },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      });

      if (perm.outcome.outcome === "cancelled" || perm.outcome.optionId === "reject") {
        await this.connection.sessionUpdate({
          sessionId: sid,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            status: "completed",
            rawOutput: { success: false, message: `User rejected deletion of ${name}` },
          },
        });
        return false;
      }

      await fs.unlink(filePath);
      await this.connection.sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          status: "completed",
          rawOutput: { success: true, message: `Deleted ${name}` },
        },
      });
      return true;
    };

    // -----------------------------------------------------------------------
    // 1. Create LOREM_1.md (single tool call)
    // -----------------------------------------------------------------------
    await this.streamWords(
      sid,
      "Hello! Let me create three LOREM files. Starting with LOREM_1.md...",
      signal,
    );
    if (signal.aborted) return { stopReason: "cancelled" };

    const created1 = await createFile("LOREM_1.md");
    if (!created1) {
      await this.streamWords(sid, "\nUnderstood — skipping file creation.", signal);
      session.pending = null;
      return { stopReason: "end_turn" };
    }

    await new Promise((r) => setTimeout(r, 300));

    // -----------------------------------------------------------------------
    // 2. Edit LOREM_1.md (single tool call)
    // -----------------------------------------------------------------------
    await this.streamWords(
      sid,
      "\nGreat, LOREM_1.md is created! Now I'll insert some boilerplate into it.",
      signal,
    );
    if (signal.aborted) return { stopReason: "cancelled" };

    await editFile("LOREM_1.md");

    await new Promise((r) => setTimeout(r, 300));

    // -----------------------------------------------------------------------
    // 3. Create LOREM_2.md and LOREM_3.md in parallel
    // -----------------------------------------------------------------------
    await this.streamWords(sid, "\nNow I'll create LOREM_2.md and LOREM_3.md in parallel.", signal);
    if (signal.aborted) return { stopReason: "cancelled" };

    await Promise.all([createFile("LOREM_2.md"), createFile("LOREM_3.md")]);

    await new Promise((r) => setTimeout(r, 300));

    // -----------------------------------------------------------------------
    // 4. Edit LOREM_2.md and LOREM_3.md in parallel
    // -----------------------------------------------------------------------
    await this.streamWords(
      sid,
      "\nNow I'll insert boilerplate into LOREM_2.md and LOREM_3.md in parallel.",
      signal,
    );
    if (signal.aborted) return { stopReason: "cancelled" };

    await Promise.all([editFile("LOREM_2.md"), editFile("LOREM_3.md")]);

    await new Promise((r) => setTimeout(r, 300));

    // -----------------------------------------------------------------------
    // 5. Delete all three files in parallel
    // -----------------------------------------------------------------------
    await this.streamWords(
      sid,
      "\nAlright, now let me clean up by deleting all three files in parallel.",
      signal,
    );
    if (signal.aborted) return { stopReason: "cancelled" };

    await Promise.all([
      deleteFile("LOREM_1.md"),
      deleteFile("LOREM_2.md"),
      deleteFile("LOREM_3.md"),
    ]);

    await this.streamWords(sid, "\nDone! All LOREM files have been deleted. All clean.", signal);

    session.pending = null;
    return { stopReason: "end_turn" };
  }

  /** Stream text word-by-word as agent_message_chunk updates. */
  private async streamWords(sessionId: string, text: string, signal: AbortSignal): Promise<void> {
    const words = text.split(" ");
    for (const word of words) {
      if (signal.aborted) return;
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: word + " " },
        },
      });
      await new Promise((r) => setTimeout(r, 40));
    }
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
