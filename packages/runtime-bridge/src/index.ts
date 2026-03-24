#!/usr/bin/env node
/* oxlint-disable no-type-assertion/no-type-assertion */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { WebSocketServer, WebSocket } from "ws";
import { startFileWatcher, type FileChange } from "./file-watcher.js";
import type { BridgeStartRequest, BridgeStartResponse, BridgeHealthResponse } from "./protocol.js";

// ---- Config from environment ----

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT ?? "8080", 10);

// ---- Types ----

type WsMessage =
  | {
      type: "event";
      timestamp: string;
      event: { type: string; data: Record<string, unknown>; timestamp: string };
    }
  | { type: "connected"; sessionId: string }
  | { type: "error"; message: string };

type ControlMessage =
  | { action: "prompt"; text: string }
  | { action: "permission.respond"; requestId: string; body: Record<string, unknown> }
  | { action: "cancel"; queueId?: string }
  | { action: "terminate" }
  | { action: "ping" };

// ---- Session state (one session at a time) ----

let sessionId = "";
let agent: ChildProcess | null = null;
let connection: acp.ClientSideConnection | null = null;
let fileWatcher: ReturnType<typeof startFileWatcher> | undefined;
const clients = new Set<WebSocket>();
const permissionResolvers = new Map<string, (response: acp.RequestPermissionResponse) => void>();

// ---- Broadcast helpers ----

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

// ---- ACP Client implementation (agent → client calls) ----

function createAcpClient(): acp.Client {
  return {
    sessionUpdate: async (params: acp.SessionNotification) => {
      emitRpc(acp.CLIENT_METHODS.session_update, "agent_to_client", "notification", params);
    },

    requestPermission: async (params: acp.RequestPermissionRequest) => {
      emitRpc(acp.CLIENT_METHODS.session_request_permission, "agent_to_client", "request", params);

      const requestId = crypto.randomUUID();
      return new Promise<acp.RequestPermissionResponse>((resolve) => {
        permissionResolvers.set(requestId, resolve);

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

    readTextFile: async (params: acp.ReadTextFileRequest) => {
      emitRpc(acp.CLIENT_METHODS.fs_read_text_file, "agent_to_client", "request", params);
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(params.path, "utf8");
      const lines = content.split("\n");
      const startLine = Math.max(params.line ?? 0, 0);
      const limitedLines =
        params.limit != null
          ? lines.slice(startLine, startLine + params.limit)
          : lines.slice(startLine);
      const response: acp.ReadTextFileResponse = { content: limitedLines.join("\n") };
      emitRpc(acp.CLIENT_METHODS.fs_read_text_file, "client_to_agent", "response", response);
      return response;
    },

    writeTextFile: async (params: acp.WriteTextFileRequest) => {
      emitRpc(acp.CLIENT_METHODS.fs_write_text_file, "agent_to_client", "request", params);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(params.path, params.content, "utf8");
      const response: acp.WriteTextFileResponse = {};
      emitRpc(acp.CLIENT_METHODS.fs_write_text_file, "client_to_agent", "response", response);
      return response;
    },

    createTerminal: async (params: acp.CreateTerminalRequest) => {
      emitRpc(acp.CLIENT_METHODS.terminal_create, "agent_to_client", "request", params);
      const response = { terminalId: `stub-${crypto.randomUUID()}` };
      emitRpc(acp.CLIENT_METHODS.terminal_create, "client_to_agent", "response", response);
      return response;
    },

    terminalOutput: async (params: acp.TerminalOutputRequest) => {
      emitRpc(acp.CLIENT_METHODS.terminal_output, "agent_to_client", "request", params);
      const response = { output: "", truncated: false };
      emitRpc(acp.CLIENT_METHODS.terminal_output, "client_to_agent", "response", response);
      return response;
    },

    releaseTerminal: async (params: acp.ReleaseTerminalRequest) => {
      emitRpc(acp.CLIENT_METHODS.terminal_release, "agent_to_client", "request", params);
      const response = {};
      emitRpc(acp.CLIENT_METHODS.terminal_release, "client_to_agent", "response", response);
      return response;
    },

    waitForTerminalExit: async (params: acp.WaitForTerminalExitRequest) => {
      emitRpc(acp.CLIENT_METHODS.terminal_wait_for_exit, "agent_to_client", "request", params);
      const response = { exitCode: 0 };
      emitRpc(acp.CLIENT_METHODS.terminal_wait_for_exit, "client_to_agent", "response", response);
      return response;
    },

    killTerminal: async (params: acp.KillTerminalRequest) => {
      emitRpc(acp.CLIENT_METHODS.terminal_kill, "agent_to_client", "request", params);
      const response = {};
      emitRpc(acp.CLIENT_METHODS.terminal_kill, "client_to_agent", "response", response);
      return response;
    },

    extMethod: async (method: string, params: Record<string, unknown>) => {
      emitRpc(method, "agent_to_client", "request", params);
      throw acp.RequestError.methodNotFound(method);
    },

    extNotification: async (method: string, params: Record<string, unknown>) => {
      emitRpc(method, "agent_to_client", "notification", params);
    },
  };
}

// ---- WebSocket control message handler ----

async function handleControl(msg: ControlMessage): Promise<void> {
  try {
    switch (msg.action) {
      case "prompt": {
        if (!connection) throw new Error("No active session");
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
          emitRpc(
            acp.CLIENT_METHODS.session_request_permission,
            "client_to_agent",
            "response",
            response,
          );
          resolver(response);
        }
        break;
      }

      case "terminate": {
        agent?.kill();
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

// ---- Session lifecycle ----

async function startSession(
  req: BridgeStartRequest,
  serverPort: number,
): Promise<BridgeStartResponse> {
  if (agent) {
    throw new Error("Session already running");
  }

  const workspace = req.workspace ?? process.cwd();

  // SMI-1677: Run optional setup command before spawning agent.
  // RUNTIME_SETUP_ENABLED is set by the Container class (deployed mode only).
  if (req.setup && process.env.RUNTIME_SETUP_ENABLED) {
    execSync(req.setup, { cwd: workspace, stdio: "inherit" });
  }

  // Spawn agent process
  // Prepend node binary's directory to PATH so nvm/volta tools (npx, tsx, etc.) resolve
  const nodeBinDir = path.dirname(process.execPath);

  const agentProcess = spawn(req.command, req.args, {
    cwd: workspace,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, PATH: `${nodeBinDir}:${process.env.PATH ?? ""}` },
  });

  if (!agentProcess.stdin || !agentProcess.stdout) {
    agentProcess.kill();
    throw new Error("Failed to get agent stdio");
  }

  agent = agentProcess;

  // Convert to Web Streams for ACP SDK
  const agentInput = Writable.toWeb(agentProcess.stdin) as WritableStream<Uint8Array>;
  const agentOutput = new ReadableStream<Uint8Array>({
    start(controller) {
      agentProcess.stdout!.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      agentProcess.stdout!.on("end", () => controller.close());
      agentProcess.stdout!.on("error", (err) => controller.error(err));
    },
  });

  // ACP connection + handshake
  const stream = acp.ndJsonStream(agentInput, agentOutput);
  const acpClient = createAcpClient();
  const conn = new acp.ClientSideConnection((_agent: acp.Agent) => acpClient, stream);
  connection = conn;

  const initParams: acp.InitializeRequest = {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  };

  emitRpc(acp.AGENT_METHODS.initialize, "client_to_agent", "request", initParams);
  const initResult = await conn.initialize(initParams);
  emitRpc(acp.AGENT_METHODS.initialize, "agent_to_client", "response", initResult);

  const newSessionParams: acp.NewSessionRequest = { cwd: workspace, mcpServers: [] };
  emitRpc(acp.AGENT_METHODS.session_new, "client_to_agent", "request", newSessionParams);
  const sessionResult = await conn.newSession(newSessionParams);
  emitRpc(acp.AGENT_METHODS.session_new, "agent_to_client", "response", sessionResult);

  sessionId = sessionResult.sessionId;

  // Start file watcher
  fileWatcher = startFileWatcher(workspace, ["node_modules", ".git"], (changes: FileChange[]) => {
    emitEvent("filesystem.changed", { changes });
  });

  // Handle agent exit
  agentProcess.on("exit", (code) => {
    emitEvent("session.terminated", { exitCode: code });
    resetSession();
  });

  return {
    sessionId,
    websocketUrl: `ws://localhost:${serverPort}`,
    port: serverPort,
  };
}

function resetSession(): void {
  agent = null;
  connection = null;
  sessionId = "";
  permissionResolvers.clear();
  fileWatcher?.close();
  fileWatcher = undefined;
}

function terminateSession(): void {
  if (agent) {
    agent.kill();
    resetSession();
  }
}

// ---- HTTP server ----

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const httpServer = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      const health: BridgeHealthResponse = agent
        ? { status: "running", sessionId }
        : { status: "idle" };
      jsonResponse(res, 200, health);
      return;
    }

    if (req.method === "POST" && req.url === "/start") {
      const body = JSON.parse(await readBody(req)) as BridgeStartRequest;
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : BRIDGE_PORT;
      const result = await startSession(body, port);
      jsonResponse(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/terminate") {
      terminateSession();
      jsonResponse(res, 200, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[runtime-bridge] request error:", message);
    jsonResponse(res, 500, { error: message });
  }
});

// ---- WebSocket server ----

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  clients.add(ws);
  if (sessionId) {
    ws.send(JSON.stringify({ type: "connected", sessionId } satisfies WsMessage));
  }

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

// ---- Start ----

httpServer.listen(BRIDGE_PORT, () => {
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : BRIDGE_PORT;
  console.log(`[runtime-bridge] listening on port ${port} (idle, waiting for POST /start)`);
});
