import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { SessionManager } from "./sessions/session-manager.js";
import { SessionError } from "./sessions/session-manager.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createMcpServer(sessions: SessionManager): McpServer {
  const mcp = new McpServer(
    { name: "flamecast", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  // 1. terminals__create
  mcp.registerTool("terminals__create", {
    title: "Create Terminal",
    description: "Spawn a new terminal session (tmux-backed).",
    inputSchema: {
      cwd: z.string().optional().describe("Working directory"),
      shell: z.string().optional().describe("Shell to spawn"),
      timeout: z
        .number()
        .nullable()
        .optional()
        .describe("Seconds of inactivity before auto-kill. 0 or null for never."),
    },
  }, async ({ cwd, shell, timeout }) => {
    const result = await sessions.create({ cwd, shell, timeout });
    return jsonResult(result);
  });

  // 2. terminals__exec
  mcp.registerTool("terminals__exec", {
    title: "Execute Command",
    description:
      "Execute a command synchronously in a terminal session. Blocks until the command completes or times out.",
    inputSchema: {
      command: z.string().describe("Command to execute"),
      sessionId: z
        .string()
        .nullable()
        .optional()
        .describe("Terminal session to run in. If null, auto-creates a new session."),
      timeout: z
        .number()
        .optional()
        .describe("Max seconds to wait for completion (default 30)"),
    },
  }, async ({ command, sessionId, timeout }) => {
    try {
      const result = await sessions.exec({
        command,
        sessionId: sessionId ?? undefined,
        timeout,
      });
      return jsonResult(result);
    } catch (err) {
      if (err instanceof SessionError) return errorResult(err.message);
      throw err;
    }
  });

  // 3. terminals__exec_async
  mcp.registerTool("terminals__exec_async", {
    title: "Execute Command (Async)",
    description:
      "Execute a command without waiting for completion. For long-running processes like dev servers, builds, watch modes.",
    inputSchema: {
      command: z.string().describe("Command to execute"),
      sessionId: z
        .string()
        .nullable()
        .optional()
        .describe("Terminal session to run in. If null, auto-creates a new session."),
    },
  }, async ({ command, sessionId }) => {
    try {
      const result = await sessions.execAsync({
        command,
        sessionId: sessionId ?? undefined,
      });
      return jsonResult(result);
    } catch (err) {
      if (err instanceof SessionError) return errorResult(err.message);
      throw err;
    }
  });

  // 4. terminals__input
  mcp.registerTool("terminals__input", {
    title: "Send Input",
    description:
      "Send keystrokes or control sequences to an interactive program (vim, REPLs, prompts, etc.).",
    inputSchema: {
      sessionId: z.string().describe("Target terminal session"),
      text: z.string().nullable().optional().describe("Literal text to type"),
      keys: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "Special keys to send after text (enter, tab, escape, ctrl+c, etc.)",
        ),
    },
  }, async ({ sessionId, text, keys }) => {
    try {
      const result = await sessions.input({
        sessionId,
        text: text ?? undefined,
        keys: keys ?? undefined,
      });
      return jsonResult(result);
    } catch (err) {
      if (err instanceof SessionError) return errorResult(err.message);
      throw err;
    }
  });

  // 5. terminals__get
  mcp.registerTool("terminals__get", {
    title: "Get Terminal Output",
    description: "Read output from a terminal session's buffer.",
    inputSchema: {
      sessionId: z.string().describe("Target terminal session"),
      tail: z
        .number()
        .nullable()
        .optional()
        .describe("Return only the last N lines"),
      since: z
        .number()
        .nullable()
        .optional()
        .describe("Return output since this byte offset (for incremental reads)"),
    },
  }, async ({ sessionId, tail, since }) => {
    try {
      const result = await sessions.get({
        sessionId,
        tail: tail ?? undefined,
        since: since ?? undefined,
      });
      return jsonResult(result);
    } catch (err) {
      if (err instanceof SessionError) return errorResult(err.message);
      throw err;
    }
  });

  // 6. terminals__list
  mcp.registerTool("terminals__list", {
    title: "List Terminals",
    description: "List all active and recently-closed terminal sessions.",
  }, async () => {
    const result = await sessions.list();
    return jsonResult(result);
  });

  // 7. terminals__close
  mcp.registerTool("terminals__close", {
    title: "Close Terminal",
    description: "Kill a terminal session and clean up.",
    inputSchema: {
      sessionId: z.string().describe("Terminal session to close"),
    },
  }, async ({ sessionId }) => {
    try {
      const result = await sessions.close({ sessionId });
      return jsonResult(result);
    } catch (err) {
      if (err instanceof SessionError) return errorResult(err.message);
      throw err;
    }
  });

  return mcp;
}

/**
 * Create an MCP request handler backed by @hono/mcp's StreamableHTTPTransport.
 */
export function createMcpHandler(sessions: SessionManager) {
  const mcp = createMcpServer(sessions);
  const transport = new StreamableHTTPTransport();

  return async (c: Context): Promise<Response> => {
    if (!mcp.isConnected()) {
      await mcp.connect(transport);
    }
    const response = await transport.handleRequest(c);
    return response ?? c.body(null, 204);
  };
}
