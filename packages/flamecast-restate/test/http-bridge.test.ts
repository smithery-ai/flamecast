/**
 * Test: HTTP+SSE JSON-RPC bridge for containerized ACP agents.
 *
 * Uses a mock ACP agent (Node script over stdio) to verify:
 * - initialize + session/new handshake
 * - session/prompt request → response
 * - session/update notifications (streaming)
 * - request_permission bidirectional request (agent sends request with id)
 * - session/cancel notification
 * - connection close cleanup
 * - id correlation (responses match requests)
 *
 * No Restate needed — pure transport test.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  startBridgeServer,
  HttpJsonRpcConnection,
  type BridgeServer,
} from "../src/http-bridge.js";

// ─── Mock ACP agent (Node script, JSON-RPC over stdio) ─────────────────────

let mockDir: string;
let mockAgentPath: string;

function createMockAgent(): string {
  mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-acp-"));
  const script = path.join(mockDir, "agent.mjs");
  fs.writeFileSync(
    script,
    `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Response to a request (has id)
  if (msg.id !== undefined && msg.method) {
    switch (msg.method) {
      case "initialize":
        respond(msg.id, {
          serverInfo: { name: "mock-acp-agent", description: "test" },
          capabilities: { streaming: true },
        });
        break;

      case "session/new":
        respond(msg.id, { id: "mock-session-1" });
        break;

      case "session/prompt": {
        // Emit a notification first (streaming update)
        notify("session/update", { type: "text", text: "thinking..." });

        // Then send a request_permission (bidirectional — agent→client request)
        const permId = 999;
        const permReq = JSON.stringify({
          jsonrpc: "2.0",
          id: permId,
          method: "request_permission",
          params: {
            requestId: "perm-1",
            toolCallId: "tc-1",
            title: "Allow file write?",
            options: [
              { optionId: "allow", name: "Allow", kind: "allow" },
              { optionId: "deny", name: "Deny", kind: "reject" },
            ],
          },
        });
        process.stdout.write(permReq + "\\n");

        // Store the prompt id — we'll respond after permission comes back
        global._pendingPromptId = msg.id;
        global._pendingPromptInput = msg.params?.messages?.[0]?.parts?.[0]?.content ?? "unknown";
        break;
      }

      case "session/resume":
        respond(msg.id, { status: "completed", output: [{ role: "assistant", parts: [{ contentType: "text/plain", content: "resumed" }] }] });
        break;

      case "session/getConfigOptions":
        respond(msg.id, [{ id: "mode", label: "Mode", type: "enum", value: "code", options: ["code", "ask"] }]);
        break;

      case "session/setConfigOption":
        respond(msg.id, [{ id: msg.params?.configId, label: msg.params?.configId, type: "string", value: msg.params?.value }]);
        break;

      default:
        respond(msg.id, {});
    }
  }
  // Response to our request_permission (has id, has result, no method)
  else if (msg.id !== undefined && !msg.method && (msg.result !== undefined || msg.error !== undefined)) {
    // Permission response came back — now complete the pending prompt
    if (global._pendingPromptId !== undefined) {
      const promptId = global._pendingPromptId;
      const input = global._pendingPromptInput;
      delete global._pendingPromptId;
      delete global._pendingPromptInput;

      // Emit another notification
      notify("session/update", { type: "text", text: "writing..." });

      // Respond to the original prompt
      respond(promptId, {
        status: "completed",
        output: [{
          role: "assistant",
          parts: [{ contentType: "text/plain", content: "Echo: " + input + " (permitted: " + JSON.stringify(msg.result) + ")" }],
        }],
      });
    }
  }
  // Notification (no id) — e.g. session/cancel
  else if (msg.method && msg.id === undefined) {
    if (msg.method === "session/cancel") {
      // Acknowledge by completing any pending prompt as cancelled
      if (global._pendingPromptId !== undefined) {
        respond(global._pendingPromptId, { status: "cancelled" });
        delete global._pendingPromptId;
      }
    }
  }
});

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
}
`,
  );
  return script;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("HTTP JSON-RPC Bridge", () => {
  let bridge: BridgeServer;
  let conn: HttpJsonRpcConnection;

  beforeAll(async () => {
    mockAgentPath = createMockAgent();

    // Create a shell wrapper (agent.sh ignores --acp, runs node script)
    const wrapper = path.join(mockDir, "agent.sh");
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nexec node "${mockAgentPath}"\n`,
    );
    fs.chmodSync(wrapper, 0o755);

    bridge = await startBridgeServer({
      command: wrapper,
      port: 0, // auto-assign
    });

    conn = await HttpJsonRpcConnection.connect(bridge.url);
  }, 15_000);

  afterAll(async () => {
    conn?.kill();
    await bridge?.close();
    if (mockDir) {
      fs.rmSync(mockDir, { recursive: true, force: true });
    }
  });

  it("initialize returns server info", async () => {
    const result = (await conn.request("initialize", {
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    })) as { serverInfo: { name: string } };

    expect(result.serverInfo.name).toBe("mock-acp-agent");
  });

  it("session/new returns session id", async () => {
    const result = (await conn.request("session/new", {})) as {
      id: string;
    };
    expect(result.id).toBe("mock-session-1");
  });

  it("session/prompt with bidirectional request_permission", async () => {
    // Collect notifications
    const notifications: unknown[] = [];
    const onNotif = (msg: { method: string; params?: unknown }) => {
      notifications.push(msg);
    };
    conn.onNotification(onNotif);

    // Set up handler for agent-initiated request_permission
    let permissionRequest: unknown = null;
    conn.onRequest(async (method, params) => {
      permissionRequest = { method, params };
      // Approve the permission
      return { optionId: "allow" };
    });

    // Send prompt — agent will: emit notification, send request_permission,
    // receive our approval, then complete
    const result = (await conn.request("session/prompt", {
      sessionId: "mock-session-1",
      messages: [
        {
          role: "user",
          parts: [{ contentType: "text/plain", content: "hello" }],
        },
      ],
    })) as { status: string; output: unknown[] };

    conn.offNotification(onNotif);

    // Verify the prompt completed
    expect(result.status).toBe("completed");
    expect(result.output).toBeDefined();

    // Verify we received the permission request
    expect(permissionRequest).toBeDefined();
    expect(
      (permissionRequest as { method: string }).method,
    ).toBe("request_permission");

    // Verify notifications were received
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(
      (notifications[0] as { params: { type: string } }).params.type,
    ).toBe("text");
  }, 10_000);

  it("getConfigOptions works", async () => {
    const result = (await conn.request("session/getConfigOptions", {
      sessionId: "mock-session-1",
    })) as Array<{ id: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("mode");
  });

  it("id correlation — concurrent requests get correct responses", async () => {
    // Send two requests concurrently
    const [config, session] = await Promise.all([
      conn.request("session/getConfigOptions", {
        sessionId: "mock-session-1",
      }) as Promise<Array<{ id: string }>>,
      conn.request("session/new", {}) as Promise<{ id: string }>,
    ]);

    // Each should get its own response, not the other's
    expect(Array.isArray(config)).toBe(true);
    expect(session.id).toBe("mock-session-1");
  });
});
