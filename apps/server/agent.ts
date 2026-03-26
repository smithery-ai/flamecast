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
    const filePath = path.join(session.cwd, "LOREM.md");

    // -----------------------------------------------------------------------
    // 1. Stream intro message
    // -----------------------------------------------------------------------
    await this.streamWords(
      sid,
      "Hello! Let me create a LOREM.md file with 100 lines of lorem ipsum for you.",
      signal,
    );
    if (signal.aborted) return { stopReason: "cancelled" };

    // -----------------------------------------------------------------------
    // 2. Tool call: create LOREM.md (needs permission)
    // -----------------------------------------------------------------------
    const loremContent = generateLoremIpsum(100);
    const createCallId = "call_" + crypto.randomUUID().slice(0, 8);

    await this.connection.sessionUpdate({
      sessionId: sid,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: createCallId,
        title: "Create LOREM.md",
        kind: "edit",
        status: "pending",
        locations: [{ path: "./LOREM.md" }],
        rawInput: { path: "./LOREM.md", content: loremContent },
      },
    });

    const createPermission = await this.connection.requestPermission({
      sessionId: sid,
      toolCall: {
        toolCallId: createCallId,
        title: "Create LOREM.md",
        kind: "edit",
        status: "pending",
        locations: [{ path: "./LOREM.md" }],
        rawInput: { path: "./LOREM.md", content: loremContent },
      },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
    });

    if (createPermission.outcome.outcome === "cancelled") return { stopReason: "cancelled" };

    if (createPermission.outcome.optionId === "reject") {
      await this.connection.sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: createCallId,
          status: "completed",
          rawOutput: { success: false, message: "User rejected file creation" },
        },
      });
      await this.streamWords(sid, "\nUnderstood — skipping file creation.", signal);
      session.pending = null;
      return { stopReason: "end_turn" };
    }

    // Permission granted — actually write the file, then mark tool call completed
    await fs.writeFile(filePath, loremContent, "utf8");

    await this.connection.sessionUpdate({
      sessionId: sid,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: createCallId,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: loremContent } }],
        rawOutput: { success: true, message: "Created LOREM.md with 100 lines" },
      },
    });

    await new Promise((r) => setTimeout(r, 300));

    // -----------------------------------------------------------------------
    // 3. Stream transition message
    // -----------------------------------------------------------------------
    await this.streamWords(
      sid,
      "\nGreat, LOREM.md is created! Now I'll insert some boilerplate in the middle of the file.",
      signal,
    );
    if (signal.aborted) return { stopReason: "cancelled" };

    // -----------------------------------------------------------------------
    // 4. Tool call: insert boilerplate in the middle (needs permission)
    // -----------------------------------------------------------------------
    const lines = loremContent.split("\n");
    const midpoint = Math.floor(lines.length / 2);
    const boilerplateLines = BOILERPLATE.split("\n");
    lines.splice(midpoint, 0, ...boilerplateLines);
    const editedContent = lines.join("\n");

    const editCallId = "call_" + crypto.randomUUID().slice(0, 8);

    await this.connection.sessionUpdate({
      sessionId: sid,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: editCallId,
        title: "Insert boilerplate into LOREM.md",
        kind: "edit",
        status: "pending",
        locations: [{ path: "./LOREM.md" }],
        rawInput: {
          path: "./LOREM.md",
          insertAtLine: midpoint,
          content: BOILERPLATE,
        },
      },
    });

    const editPermission = await this.connection.requestPermission({
      sessionId: sid,
      toolCall: {
        toolCallId: editCallId,
        title: "Insert boilerplate into LOREM.md",
        kind: "edit",
        status: "pending",
        locations: [{ path: "./LOREM.md" }],
        rawInput: {
          path: "./LOREM.md",
          insertAtLine: midpoint,
          content: BOILERPLATE,
        },
      },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
    });

    if (editPermission.outcome.outcome === "cancelled") return { stopReason: "cancelled" };

    if (editPermission.outcome.optionId === "reject") {
      await this.connection.sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: editCallId,
          status: "completed",
          rawOutput: { success: false, message: "User rejected edit" },
        },
      });
      await this.streamWords(sid, "\nSkipping the edit.", signal);
    } else {
      // Actually write the edited content
      await fs.writeFile(filePath, editedContent, "utf8");

      await this.connection.sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: editCallId,
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: editedContent } }],
          rawOutput: { success: true, message: "Inserted boilerplate at line " + midpoint },
        },
      });
    }

    await new Promise((r) => setTimeout(r, 300));

    // -----------------------------------------------------------------------
    // 5. Stream transition message
    // -----------------------------------------------------------------------
    await this.streamWords(sid, "\nAlright, now let me clean up by deleting LOREM.md.", signal);
    if (signal.aborted) return { stopReason: "cancelled" };

    // -----------------------------------------------------------------------
    // 6. Tool call: delete LOREM.md (needs permission)
    // -----------------------------------------------------------------------
    const deleteCallId = "call_" + crypto.randomUUID().slice(0, 8);

    await this.connection.sessionUpdate({
      sessionId: sid,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: deleteCallId,
        title: "Delete LOREM.md",
        kind: "edit",
        status: "pending",
        locations: [{ path: "./LOREM.md" }],
        rawInput: { path: "./LOREM.md", action: "delete" },
      },
    });

    const deletePermission = await this.connection.requestPermission({
      sessionId: sid,
      toolCall: {
        toolCallId: deleteCallId,
        title: "Delete LOREM.md",
        kind: "edit",
        status: "pending",
        locations: [{ path: "./LOREM.md" }],
        rawInput: { path: "./LOREM.md", action: "delete" },
      },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
    });

    if (deletePermission.outcome.outcome === "cancelled") return { stopReason: "cancelled" };

    if (deletePermission.outcome.optionId === "reject") {
      await this.connection.sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: deleteCallId,
          status: "completed",
          rawOutput: { success: false, message: "User rejected deletion" },
        },
      });
      await this.streamWords(sid, "\nOk, keeping LOREM.md in place.", signal);
    } else {
      // Actually delete the file
      await fs.unlink(filePath);

      await this.connection.sessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: deleteCallId,
          status: "completed",
          rawOutput: { success: true, message: "Deleted LOREM.md" },
        },
      });
      await this.streamWords(sid, "\nDone! LOREM.md has been deleted. All clean.", signal);
    }

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
