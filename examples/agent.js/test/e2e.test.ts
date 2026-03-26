import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, test } from "vitest";
import { openWorkerAcpTransport } from "../src/runtime-provider.js";
import { startExampleMiniflare } from "../src/miniflare.js";

let cleanup = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.map((fn) => fn()));
  cleanup = [];
});

function collectCompletedResults(events) {
  return events
    .map((event) => event.update)
    .filter(Boolean)
    .filter(
      (update) =>
        update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update",
    )
    .filter((update) => update.status === "completed")
    .map((update) => update.rawOutput?.result);
}

function createAcpClient(events) {
  return {
    sessionUpdate: async (params) => {
      events.push(params);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
    createTerminal: async () => ({ terminalId: `stub-${crypto.randomUUID()}` }),
    terminalOutput: async () => ({ output: "", truncated: false }),
    releaseTerminal: async () => ({}),
    waitForTerminalExit: async () => ({ exitCode: 0 }),
    killTerminal: async () => ({}),
    extMethod: async (method) => {
      throw acp.RequestError.methodNotFound(method);
    },
    extNotification: async () => {},
  };
}

async function connectSession(websocketUrl, sessionId) {
  const transport = await openWorkerAcpTransport(
    `${websocketUrl.replace(/\/$/, "")}/${encodeURIComponent(sessionId)}`,
  );
  const events = [];
  const connection = new acp.ClientSideConnection(
    () => createAcpClient(events),
    acp.ndJsonStream(transport.input, transport.output),
  );

  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const created = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });

  return {
    connection,
    events,
    sessionId: created.sessionId,
    dispose: async () => {
      await transport.dispose?.();
    },
  };
}

describe("agent.js example", () => {
  test("runs executeJS over ACP and preserves session scope across prompts", async () => {
    const local = await startExampleMiniflare({
      bindings: { AGENT_MODE: "scripted" },
      port: 0,
    });
    cleanup.push(() => local.dispose());

    const session = await connectSession(local.websocketUrl, `counter-${randomUUID()}`);
    cleanup.push(() => session.dispose());

    const first = await session.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Increment the counter and return it." }],
    });
    const second = await session.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Increment the counter again and return it." }],
    });

    expect(first).toEqual({ stopReason: "end_turn" });
    expect(second).toEqual({ stopReason: "end_turn" });
    expect(collectCompletedResults(session.events)).toEqual([{ counter: 1 }, { counter: 2 }]);
  });

  test("supports node:fs access against the virtual tmp filesystem contract", async () => {
    const local = await startExampleMiniflare({
      bindings: { AGENT_MODE: "scripted" },
      port: 0,
    });
    cleanup.push(() => local.dispose());

    const session = await connectSession(local.websocketUrl, `tmp-${randomUUID()}`);
    cleanup.push(() => session.dispose());

    const result = await session.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Use node:fs to write a tmp file and return its contents." }],
    });

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(collectCompletedResults(session.events)).toEqual([
      {
        path: "/tmp/hello.txt",
        contents: "Hello from executeJS",
      },
    ]);
  });

  test("persists session scope across ACP reconnects for the same session id", async () => {
    const local = await startExampleMiniflare({
      bindings: { AGENT_MODE: "scripted" },
      port: 0,
    });
    cleanup.push(() => local.dispose());

    const sessionId = `reconnect-${randomUUID()}`;
    const first = await connectSession(local.websocketUrl, sessionId);
    cleanup.push(() => first.dispose());

    const firstResult = await first.connection.prompt({
      sessionId: first.sessionId,
      prompt: [{ type: "text", text: "Increment the counter and return it." }],
    });
    expect(firstResult).toEqual({ stopReason: "end_turn" });
    expect(collectCompletedResults(first.events)).toEqual([{ counter: 1 }]);

    await first.dispose();

    const second = await connectSession(local.websocketUrl, sessionId);
    cleanup.push(() => second.dispose());

    const secondResult = await second.connection.prompt({
      sessionId: second.sessionId,
      prompt: [{ type: "text", text: "Increment the counter again and return it." }],
    });

    expect(secondResult).toEqual({ stopReason: "end_turn" });
    expect(collectCompletedResults(second.events)).toEqual([{ counter: 2 }]);
  });
});
