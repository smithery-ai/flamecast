#!/usr/bin/env node
import { spawn, exec, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import path from "node:path";
import { Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { WebSocketServer, WebSocket } from "ws";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startFileWatcher, type FileChange } from "./file-watcher.js";
import { readBody, jsonResponse, handleCors } from "./http-utils.js";
import { walkDirectory } from "./walk-directory.js";
import type {
  SessionHostStartRequest,
  SessionHostStartResponse,
  SessionHostHealthResponse,
  SessionCallbackEvent,
} from "@flamecast/protocol/session-host";
import type { WsServerMessage, WsControlMessage } from "@flamecast/protocol/ws";

// ---- Config from environment ----

const SESSION_HOST_PORT = parseInt(process.env.SESSION_HOST_PORT ?? "8787", 10);

// ---- Session state (one session at a time) ----

let sessionId = "";
let sessionWorkspace = "";
let callbackUrl = "";
let agent: ChildProcess | null = null;
let connection: acp.ClientSideConnection | null = null;
let fileWatcher: ReturnType<typeof startFileWatcher> | undefined;
const clients = new Set<WebSocket>();
const permissionResolvers = new Map<string, (response: acp.RequestPermissionResponse) => void>();

// ---- Control plane callback ----

/**
 * POST an event to the control plane's callback URL.
 * Returns the parsed JSON response, or null if no callbackUrl is configured.
 */
async function postCallback(event: SessionCallbackEvent): Promise<Record<string, unknown> | null> {
  if (!callbackUrl) return null;
  try {
    const resp = await fetch(`${callbackUrl}/agents/${sessionId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}

// ---- Broadcast helpers ----

function broadcast(msg: WsServerMessage): void {
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
      void postCallback({ type: "agent_message", data: { sessionUpdate: params } });
    },

    requestPermission: async (params: acp.RequestPermissionRequest) => {
      emitRpc(acp.CLIENT_METHODS.session_request_permission, "agent_to_client", "request", params);

      const requestId = crypto.randomUUID();
      const eventData = {
        requestId,
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? "",
        kind: params.toolCall.kind ?? undefined,
        options: params.options.map((o: acp.PermissionOption) => ({
          optionId: o.optionId,
          name: o.name,
          kind: String(o.kind),
        })),
      };

      // Try the control plane callback first — if it returns a decision, resolve immediately
      const result = await postCallback({ type: "permission_request", data: eventData });
      const optionId = result && typeof result.optionId === "string" ? result.optionId : null;
      if (optionId) {
        emitRpc(
          acp.CLIENT_METHODS.session_request_permission,
          "client_to_agent",
          "response",
          result,
        );
        return { outcome: { outcome: "selected", optionId } };
      }
      if (result && "outcome" in result && result.outcome === "cancelled") {
        return { outcome: { outcome: "cancelled" } };
      }

      // Callback deferred or unavailable — fall back to WS-based permission flow
      return new Promise<acp.RequestPermissionResponse>((resolve) => {
        permissionResolvers.set(requestId, resolve);
        emitEvent("permission_request", eventData);
      });
    },

    readTextFile: async (params: acp.ReadTextFileRequest) => {
      emitRpc(acp.CLIENT_METHODS.fs_read_text_file, "agent_to_client", "request", params);
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

async function handleControl(ws: WebSocket, msg: WsControlMessage): Promise<void> {
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
          // ACP SDK expects { outcome: { outcome: "selected", optionId } } or { outcome: { outcome: "cancelled" } }
          const response: acp.RequestPermissionResponse =
            "optionId" in msg.body
              ? { outcome: { outcome: "selected", optionId: msg.body.optionId } }
              : { outcome: { outcome: "cancelled" } };
          emitRpc(
            acp.CLIENT_METHODS.session_request_permission,
            "client_to_agent",
            "response",
            response,
          );
          resolver(response);
          // Notify all clients that the permission was resolved
          const outcome = response.outcome.outcome === "selected" ? "approved" : "rejected";
          emitEvent(`permission_${outcome}`, {
            requestId: msg.requestId,
            response,
          });
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
    const message = error instanceof Error ? error.message : "Unknown error";
    broadcast({ type: "error", message });
    void postCallback({ type: "error", data: { message } });
  }
}

// ---- Session lifecycle ----

async function startSession(
  req: SessionHostStartRequest,
  serverPort: number,
): Promise<SessionHostStartResponse> {
  if (agent) {
    throw new Error("Session already running");
  }

  const workspace = req.workspace ?? process.cwd();
  sessionWorkspace = workspace;
  callbackUrl = req.callbackUrl ?? "";

  try {
    return await doStartSession(req, workspace, serverPort);
  } catch (err) {
    // Clean up partial state if handshake or spawn failed
    resetSession();
    throw err;
  }
}

async function doStartSession(
  req: SessionHostStartRequest,
  workspace: string,
  serverPort: number,
): Promise<SessionHostStartResponse> {
  // SMI-1677: Run optional setup command before spawning agent.
  // RUNTIME_SETUP_ENABLED is set by the Container class (deployed mode only).
  if (req.setup && process.env.RUNTIME_SETUP_ENABLED) {
    const execAsync = promisify(exec);
    await execAsync(req.setup, { cwd: workspace });
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

  // Race the ACP handshake against the agent process exiting early.
  // If the process dies (e.g. command not found), reject immediately
  // instead of hanging forever waiting for ACP responses on a dead pipe.
  let rejectEarlyExit: ((err: Error) => void) | null = null;
  const earlyExit = new Promise<never>((_, reject) => {
    rejectEarlyExit = reject;
  });
  // Prevent unhandled rejection if earlyExit loses the race
  earlyExit.catch(() => {});

  const onSpawnError = (err: Error) => {
    rejectEarlyExit?.(new Error(`Agent process failed to start: ${err.message}`));
  };
  const onEarlyExit = (code: number | null, signal: string | null) => {
    rejectEarlyExit?.(
      new Error(
        `Agent process exited during startup (code=${code}, signal=${signal}). ` +
          `Is "${req.command}" available in this environment?`,
      ),
    );
  };
  agentProcess.on("error", onSpawnError);
  agentProcess.on("exit", onEarlyExit);

  // Convert to Web Streams for ACP SDK
  const stdin = agentProcess.stdin;
  const stdout = agentProcess.stdout;
  const agentInput: WritableStream<Uint8Array> = Writable.toWeb(stdin);
  const agentOutput = new ReadableStream<Uint8Array>({
    start(controller) {
      stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      stdout.on("end", () => controller.close());
      stdout.on("error", (err) => controller.error(err));
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

  // Race handshake against early exit — if the process dies, we get a clear error
  emitRpc(acp.AGENT_METHODS.initialize, "client_to_agent", "request", initParams);
  const initResult = await Promise.race([conn.initialize(initParams), earlyExit]);
  emitRpc(acp.AGENT_METHODS.initialize, "agent_to_client", "response", initResult);

  const newSessionParams: acp.NewSessionRequest = { cwd: workspace, mcpServers: [] };
  emitRpc(acp.AGENT_METHODS.session_new, "client_to_agent", "request", newSessionParams);
  const sessionResult = await Promise.race([conn.newSession(newSessionParams), earlyExit]);
  emitRpc(acp.AGENT_METHODS.session_new, "agent_to_client", "response", sessionResult);

  sessionId = sessionResult.sessionId;

  // Handshake succeeded — remove the startup-phase listeners and install
  // the normal exit handler for the remainder of the session's lifetime.
  agentProcess.removeListener("error", onSpawnError);
  agentProcess.removeListener("exit", onEarlyExit);
  rejectEarlyExit = null;

  // Start file watcher
  fileWatcher = startFileWatcher(workspace, ["node_modules", ".git"], (changes: FileChange[]) => {
    emitEvent("filesystem.changed", { changes });
  });

  // Handle agent exit (post-startup)
  agentProcess.on("exit", (code) => {
    emitEvent("session.terminated", { exitCode: code });
    void postCallback({ type: "session_end", data: { exitCode: code } });
    resetSession();
  });

  return {
    acpSessionId: sessionId,
    hostUrl: `http://localhost:${serverPort}`,
    websocketUrl: `ws://localhost:${serverPort}`,
  };
}

function resetSession(): void {
  agent = null;
  connection = null;
  sessionId = "";
  sessionWorkspace = "";
  callbackUrl = "";
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

const httpServer = createServer(async (req, res) => {
  try {
    if (handleCors(req, res)) return;

    if (req.method === "GET" && req.url === "/health") {
      const health: SessionHostHealthResponse = agent
        ? { status: "running", sessionId }
        : { status: "idle" };
      jsonResponse(res, 200, health);
      return;
    }

    if (req.method === "POST" && req.url === "/start") {
      // Validated upstream by SessionService before forwarding to the runtime.
      // Type annotation is compile-time only; no runtime zod validation here
      // to keep session-host free of the @flamecast/protocol runtime dep.
      const body: SessionHostStartRequest = JSON.parse(await readBody(req));
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : SESSION_HOST_PORT;
      const startResult = await startSession(body, port);
      jsonResponse(res, 200, startResult);
      return;
    }

    if (req.method === "POST" && req.url === "/terminate") {
      terminateSession();
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/files")) {
      if (!sessionWorkspace) {
        jsonResponse(res, 400, { error: "No active session" });
        return;
      }
      const fileUrl = new URL(req.url, "http://localhost");
      const filePath = fileUrl.searchParams.get("path");
      if (!filePath) {
        jsonResponse(res, 400, { error: "Missing ?path= parameter" });
        return;
      }
      const resolved = resolve(sessionWorkspace, filePath);
      if (!resolved.startsWith(sessionWorkspace)) {
        jsonResponse(res, 403, { error: "Path outside workspace" });
        return;
      }
      try {
        const raw = await readFile(resolved, "utf8");
        const maxChars = 100_000;
        const truncated = raw.length > maxChars;
        const content = truncated ? raw.slice(0, maxChars) : raw;
        jsonResponse(res, 200, { path: filePath, content, truncated, maxChars });
      } catch {
        jsonResponse(res, 404, { error: `Cannot read: ${filePath}` });
      }
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/fs/snapshot")) {
      if (!sessionWorkspace) {
        jsonResponse(res, 400, { error: "No active session" });
        return;
      }
      const entries = await walkDirectory(sessionWorkspace);
      const maxEntries = 10_000;
      const truncated = entries.length > maxEntries;
      const limited = truncated ? entries.slice(0, maxEntries) : entries;
      jsonResponse(res, 200, { root: sessionWorkspace, entries: limited, truncated, maxEntries });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[session-host] request error:", message);
    jsonResponse(res, 500, { error: message });
  }
});

// ---- WebSocket server ----

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  clients.add(ws);
  if (sessionId) {
    ws.send(JSON.stringify({ type: "connected", sessionId } satisfies WsServerMessage));
  }

  ws.on("message", (data) => {
    try {
      // Type annotation is compile-time only; WS messages come from the
      // SDK client which is already typed. No runtime zod validation to
      // keep session-host free of the @flamecast/protocol runtime dep.
      const msg: WsControlMessage = JSON.parse(String(data));
      void handleControl(ws, msg);
    } catch {
      ws.send(
        JSON.stringify({ type: "error", message: "Invalid message" } satisfies WsServerMessage),
      );
    }
  });

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

// ---- Start ----

httpServer.listen(SESSION_HOST_PORT, () => {
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : SESSION_HOST_PORT;
  console.log(`[session-host] listening on port ${port} (idle, waiting for POST /start)`);
});
