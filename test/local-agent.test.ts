import { describe, it, expect, inject } from "vitest";

describe("local agent (ChildProcess stdio transport)", () => {
  it("creates a connection, prompts, resolves permission, and receives agent message", async () => {
    const api = inject("apiBaseUrl");

    // Create a local connection to the example agent — same preset, different transport
    const createRes = await fetch(`${api}/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentProcessId: "example",
        runtimeKind: "local",
      }),
    });
    expect(createRes.status).toBe(201);
    const conn = await createRes.json();
    expect(conn.id).toBeTruthy();
    expect(conn.sessionId).toBeTruthy();

    const connId = conn.id;

    try {
      // Prompt the agent (blocks on permission)
      const promptPromise = fetch(`${api}/connections/${connId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello from local transport test!" }),
      });

      // Wait for permission request
      const pendingPermission = await pollForPermission(api, connId, 15_000);
      expect(pendingPermission).toBeDefined();
      expect(pendingPermission.title).toContain("Modifying");

      // Resolve permission
      const allowOption = pendingPermission.options.find(
        (o: { optionId: string }) => o.optionId === "allow",
      );
      await fetch(`${api}/connections/${connId}/permissions/${pendingPermission.requestId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: allowOption.optionId }),
      });

      // Wait for prompt to complete
      const promptRes = await promptPromise;
      expect(promptRes.status).toBe(200);
      const promptResult = await promptRes.json();
      expect(promptResult.stopReason).toBe("end_turn");

      // Verify agent message — same assertions as docker test
      const connState = await fetch(`${api}/connections/${connId}`).then((r) => r.json());
      const messageChunks = connState.logs
        .filter(
          (l: { type: string; data: { sessionUpdate?: string } }) =>
            l.type === "session_update" && l.data.sessionUpdate === "agent_message_chunk",
        )
        .map((l: { data: { content?: { text?: string } } }) => l.data.content?.text ?? "");

      const fullMessage = messageChunks.join("");
      expect(fullMessage.length).toBeGreaterThan(0);
      expect(fullMessage).toContain("configuration");
    } finally {
      await fetch(`${api}/connections/${connId}`, { method: "DELETE" });
    }
  });
});

async function pollForPermission(api: string, connId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${api}/connections/${connId}`);
    const conn = await res.json();
    if (conn.pendingPermission) {
      return conn.pendingPermission;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No pending permission after ${timeoutMs}ms`);
}
