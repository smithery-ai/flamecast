#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { WebSocketServer, WebSocket } from "ws";
import { startFileWatcher, type FileChange } from "./file-watcher.js";

// ---- Config from environment ----

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT ?? "0", 10);
const BRIDGE_WORKSPACE = process.env.BRIDGE_WORKSPACE ?? process.cwd();
const AGENT_COMMAND = process.env.AGENT_COMMAND ?? "";
const AGENT_ARGS = process.env.AGENT_ARGS ? JSON.parse(process.env.AGENT_ARGS) as string[] : [];
const AGENT_CWD = process.env.AGENT_CWD ?? BRIDGE_WORKSPACE;
const FILE_WATCHER_ENABLED = process.env.FILE_WATCHER_ENABLED !== "false";
const FILE_WATCHER_IGNORE = process.env.FILE_WATCHER_IGNORE
  ? (JSON.parse(process.env.FILE_WATCHER_IGNORE) as string[])
  : ["node_modules", ".git"];

if (!AGENT_COMMAND) {
  console.error("AGENT_COMMAND is required");
  process.exit(1);
}

// ---- Types ----

type WsMessage =
  | { type: "event"; timestamp: string; event: { type: string; data: Record<string, unknown>; timestamp: string } }
  | { type: "connected"; sessionId: string }
  | { type: "error"; message: string };

type ControlMessage =
  | { action: "prompt"; text: string }
  | { action: "permission.respond"; requestId: string; body: Record<string, unknown> }
  | { action: "cancel"; queueId?: string }
  | { action: "terminate" }
  | { action: "ping" };

// ---- Spawn agent process ----

const agent = spawn(AGENT_COMMAND, AGENT_ARGS, {
  cwd: AGENT_CWD,
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env },
});

if (!agent.stdin || !agent.stdout) {
  console.error("Failed to get agent stdio");
  process.exit(1);
}

// Convert to Web Streams for ACP SDK
const agentInput = Writable.toWeb(agent.stdin) as WritableStream<Uint8Array>;
const agentOutput = new ReadableStream<Uint8Array>({
  start(controller) {
    agent.stdout!.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
    agent.stdout!.on("end", () => controller.close());
    agent.stdout!.on("error", (err) => controller.error(err));
  },
});

// ---- ACP connection ----

const stream = acp.ndJsonStream(agentInput, agentOutput);

let sessionId = "";
const clients = new Set<WebSocket>();
const permissionResolvers = new Map<string, (response: acp.RequestPermissionResponse) => void>();

function broadcast(msg: WsMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function emitEvent(type: string, eventData: Record<string, unknown>): void {
  const now = new Date().toISOString();
  broadcast({
    type: "event",
    timestamp: now,
    event: { type, data: eventData, timestamp: now },
  });
}

function emitRpc(
  method: string,
  direction: "client_to_agent" | "agent_to_client",
  phase: "request" | "response" | "notification",
  payload?: unknown,
): void {
  const data: Record<string, unknown> = { method, direction, phase };
  if (payload !== undefined) data.payload = payload;
  emitEvent("rpc", data);
}

// ACP Client implementation (agent → client calls)
const acpClient: acp.Client = {
  sessionUpdate: async (params) => {
    emitRpc(acp.CLIENT_METHODS.session_update, "agent_to_client", "notification", params);
  },

  requestPermission: async (params) => {
    emitRpc(acp.CLIENT_METHODS.session_request_permission, "agent_to_client", "request", params);

    const requestId = crypto.randomUUID();
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      permissionResolvers.set(requestId, resolve);

      // Emit a structured permission request event
      emitEvent("permission_request", {
        requestId,
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? "",
        kind: params.toolCall.kind ?? undefined,
        options: params.options.map((o: acp.PermissionOption) => ({
          optionId: o.optionId,
          name: o.name,
          kind: String(o.kind),
        })),
      });
    });
  },

  readTextFile: async (params) => {
    emitRpc(acp.CLIENT_METHODS.fs_read_text_file, "agent_to_client", "request", params);
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(params.path, "utf8");
    const lines = content.split("\n");
    const startLine = Math.max(params.line ?? 0, 0);
    const limitedLines = params.limit != null
      ? lines.slice(startLine, startLine + params.limit)
      : lines.slice(startLine);
    const response: acp.ReadTextFileResponse = { content: limitedLines.join("\n") };
    emitRpc(acp.CLIENT_METHODS.fs_read_text_file, "client_to_agent", "response", response);
    return response;
  },

  writeTextFile: async (params) => {
    emitRpc(acp.CLIENT_METHODS.fs_write_text_file, "agent_to_client", "request", params);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(params.path, params.content, "utf8");
    const response: acp.WriteTextFileResponse = {};
    emitRpc(acp.CLIENT_METHODS.fs_write_text_file, "client_to_agent", "response", response);
    return response;
  },

  createTerminal: async (params) => {
    emitRpc(acp.CLIENT_METHODS.terminal_create, "agent_to_client", "request", params);
    const response = { terminalId: `stub-${crypto.randomUUID()}` };
    emitRpc(acp.CLIENT_METHODS.terminal_create, "client_to_agent", "response", response);
    return response;
  },

  terminalOutput: async (params) => {
    emitRpc(acp.CLIENT_METHODS.terminal_output, "agent_to_client", "request", params);
    const response = { output: "", truncated: false };
    emitRpc(acp.CLIENT_METHODS.terminal_output, "client_to_agent", "response", response);
    return response;
  },

  releaseTerminal: async (params) => {
    emitRpc(acp.CLIENT_METHODS.terminal_release, "agent_to_client", "request", params);
    const response = {};
    emitRpc(acp.CLIENT_METHODS.terminal_release, "client_to_agent", "response", response);
    return response;
  },

  waitForTerminalExit: async (params) => {
    emitRpc(acp.CLIENT_METHODS.terminal_wait_for_exit, "agent_to_client", "request", params);
    const response = { exitCode: 0 };
    emitRpc(acp.CLIENT_METHODS.terminal_wait_for_exit, "client_to_agent", "response", response);
    return response;
  },

  killTerminal: async (params) => {
    emitRpc(acp.CLIENT_METHODS.terminal_kill, "agent_to_client", "request", params);
    const response = {};
    emitRpc(acp.CLIENT_METHODS.terminal_kill, "client_to_agent", "response", response);
    return response;
  },

  extMethod: async (method, params) => {
    emitRpc(method, "agent_to_client", "request", params);
    throw acp.RequestError.methodNotFound(method);
  },

  extNotification: async (method, params) => {
    emitRpc(method, "agent_to_client", "notification", params);
  },
};

const connection = new acp.ClientSideConnection((_agent) => acpClient, stream);

// ---- WebSocket server ----

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", sessionId }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "connected", sessionId } satisfies WsMessage));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data)) as ControlMessage;
      void handleControl(msg);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid message" } satisfies WsMessage));
    }
  });

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

async function handleControl(msg: ControlMessage): Promise<void> {
  try {
    switch (msg.action) {
      case "prompt": {
        const params: acp.PromptRequest = {
          sessionId,
          prompt: [{ type: "text", text: msg.text }],
        };
        emitRpc(acp.AGENT_METHODS.session_prompt, "client_to_agent", "request", params);
        const result = await connection.prompt(params);
        emitRpc(acp.AGENT_METHODS.session_prompt, "agent_to_client", "response", result);
        break;
      }

      case "permission.respond": {
        const resolver = permissionResolvers.get(msg.requestId);
        if (resolver) {
          permissionResolvers.delete(msg.requestId);
          const response = msg.body as unknown as acp.RequestPermissionResponse;
          emitRpc(acp.CLIENT_METHODS.session_request_permission, "client_to_agent", "response", response);
          resolver(response);
        }
        break;
      }

      case "terminate": {
        agent.kill();
        break;
      }

      case "ping":
        break;
    }
  } catch (error) {
    broadcast({
      type: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// ---- File watcher ----

if (FILE_WATCHER_ENABLED) {
  startFileWatcher(BRIDGE_WORKSPACE, FILE_WATCHER_IGNORE, (changes: FileChange[]) => {
    emitEvent("filesystem.changed", { changes });
  });
}

// ---- Agent lifecycle ----

agent.on("exit", (code) => {
  emitEvent("session.terminated", { exitCode: code });
  setTimeout(() => process.exit(code ?? 0), 500);
});

// ---- Initialize ACP and start server ----

async function main(): Promise<void> {
  // ACP handshake
  const initParams: acp.InitializeRequest = {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  };

  emitRpc(acp.AGENT_METHODS.initialize, "client_to_agent", "request", initParams);
  const initResult = await connection.initialize(initParams);
  emitRpc(acp.AGENT_METHODS.initialize, "agent_to_client", "response", initResult);

  const newSessionParams: acp.NewSessionRequest = { cwd: AGENT_CWD, mcpServers: [] };
  emitRpc(acp.AGENT_METHODS.session_new, "client_to_agent", "request", newSessionParams);
  const sessionResult = await connection.newSession(newSessionParams);
  emitRpc(acp.AGENT_METHODS.session_new, "agent_to_client", "response", sessionResult);

  sessionId = sessionResult.sessionId;

  // Start HTTP+WS server
  httpServer.listen(BRIDGE_PORT, () => {
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : BRIDGE_PORT;

    // Signal readiness to parent process
    const readyMessage = JSON.stringify({
      ready: true,
      port,
      sessionId,
      websocketUrl: `ws://localhost:${port}`,
    });
    process.stdout.write(readyMessage + "\n");
  });
}

main().catch((error) => {
  console.error("Runtime bridge failed to start:", error);
  agent.kill();
  process.exit(1);
});
