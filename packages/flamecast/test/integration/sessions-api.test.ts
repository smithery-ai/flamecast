import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { testClient } from "hono/testing";
import { Flamecast } from "../../src/flamecast/index.js";
import type { AppType } from "../../src/flamecast/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as tmux from "../../src/flamecast/sessions/tmux.js";

const exec = promisify(execFile);

/**
 * Integration tests for the Terminals REST API using Hono RPC.
 *
 * These tests use `testClient` (same typed interface as `hc()`) against the
 * real Hono app with a real SessionManager backed by real tmux sessions —
 * nothing is mocked.
 *
 * Requirements:
 *   - tmux must be installed and available in $PATH
 */

async function tmuxAvailable(): Promise<boolean> {
  try {
    await exec("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

describe("Terminals REST API (integration)", async () => {
  const hasTmux = await tmuxAvailable();
  if (!hasTmux) {
    it.skip("tmux is not installed — skipping integration tests", () => {});
    return;
  }

  let flamecast: Flamecast;
  let client: ReturnType<typeof testClient<AppType>>;
  const createdSessionIds: string[] = [];

  function track(id: string) {
    createdSessionIds.push(id);
  }

  async function createAndTrack(
    body: {
      cwd?: string;
      shell?: string;
      timeout?: number | null;
      cols?: number;
      rows?: number;
    } = {},
  ) {
    const res = await client.api.terminals.$post({ json: body });
    const data = await res.json();
    if ("error" in data) throw new Error(`Create failed: ${data.error}`);
    track(data.sessionId);
    return { res, data };
  }

  beforeAll(() => {
    flamecast = new Flamecast();
    client = testClient(flamecast.app);
  });

  afterEach(async () => {
    for (const id of createdSessionIds) {
      try {
        await client.api.terminals[":id"].$delete({ param: { id } });
      } catch {
        // already cleaned up
      }
    }
    createdSessionIds.length = 0;
  });

  // ─── POST /api/terminals ───

  describe("POST /api/terminals", () => {
    it("creates a new session with defaults", async () => {
      const { res, data } = await createAndTrack();

      expect(res.status).toBe(201);
      expect(data.sessionId).toMatch(/^fc_[0-9a-f]{8}$/);
      expect(data.streamUrl).toBe(`/terminals/${data.sessionId}/stream`);
      expect(data.cwd).toEqual(expect.any(String));
      expect(data.shell).toEqual(expect.any(String));
      expect(data.timeout).toBe(300);
    });

    it("creates a session with custom timeout", async () => {
      const { res, data } = await createAndTrack({ timeout: 60 });

      expect(res.status).toBe(201);
      expect(data.timeout).toBe(60);
    });

    it("creates a session with null timeout (no expiry)", async () => {
      const { res, data } = await createAndTrack({ timeout: null });

      expect(res.status).toBe(201);
      expect(data.timeout).toBeNull();
    });

    it("creates a session with custom cwd", async () => {
      const { res, data } = await createAndTrack({ cwd: "/tmp" });

      expect(res.status).toBe(201);
      expect(data.cwd).toBe("/tmp");
    });

    it("creates a session with custom dimensions", async () => {
      const { res, data } = await createAndTrack({ cols: 120, rows: 40 });

      expect(res.status).toBe(201);
      await expect(tmux.getWindowSize(data.sessionId)).resolves.toEqual({ cols: 120, rows: 40 });
    });
  });

  // ─── GET /api/terminals ───

  describe("GET /api/terminals", () => {
    it("returns empty list when no sessions exist", async () => {
      const res = await client.api.terminals.$get();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.sessions).toEqual(expect.any(Array));
    });

    it("lists created sessions", async () => {
      const { data: s1 } = await createAndTrack();
      const { data: s2 } = await createAndTrack();

      const res = await client.api.terminals.$get();
      const data = await res.json();

      expect(res.status).toBe(200);
      const ids = data.sessions.map((s) => s.sessionId);
      expect(ids).toContain(s1.sessionId);
      expect(ids).toContain(s2.sessionId);

      const session = data.sessions.find((s) => s.sessionId === s1.sessionId);
      expect(session).toBeDefined();
      expect(session?.status).toBe("running");
      expect(session?.cwd).toEqual(expect.any(String));
      expect(session?.shell).toEqual(expect.any(String));
      expect(session?.created).toEqual(expect.any(String));
      expect(session?.lastActivity).toEqual(expect.any(String));
      expect(session?.streamUrl).toEqual(expect.any(String));
    });
  });

  // ─── GET /api/terminals/:id ───

  describe("GET /api/terminals/:id", () => {
    it("returns session details for a valid session", async () => {
      const { data: created } = await createAndTrack();

      const res = await client.api.terminals[":id"].$get({
        param: { id: created.sessionId },
        query: {},
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      if ("error" in data) throw new Error(`Unexpected error: ${data.error}`);
      expect(data.sessionId).toBe(created.sessionId);
      expect(data.status).toBe("running");
      expect(data.output).toEqual(expect.any(String));
      expect(data.lineCount).toEqual(expect.any(Number));
      expect(data.byteOffset).toEqual(expect.any(Number));
      expect(data.cwd).toEqual(expect.any(String));
      expect(data.streamUrl).toBe(`/terminals/${created.sessionId}/stream`);
    });

    it("returns 404 for a non-existent session", async () => {
      const res = await client.api.terminals[":id"].$get({
        param: { id: "fc_00000000" },
        query: {},
      });

      expect(res.status).toBe(404);
    });
  });

  // ─── DELETE /api/terminals/:id ───

  describe("DELETE /api/terminals/:id", () => {
    it("closes a running session", async () => {
      const { data: created } = await createAndTrack();

      const res = await client.api.terminals[":id"].$delete({
        param: { id: created.sessionId },
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      if ("error" in data) throw new Error(`Unexpected error: ${data.error}`);
      expect(data.sessionId).toBe(created.sessionId);
      expect(data.status).toBe("closed");
      expect(data.finalOutput).toEqual(expect.any(String));
    });

    it("returns 404 for a non-existent session", async () => {
      const res = await client.api.terminals[":id"].$delete({
        param: { id: "fc_00000000" },
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /api/terminals/:id/exec ───

  describe("POST /api/terminals/:id/exec", () => {
    it("executes a command and returns output", async () => {
      const { data: created } = await createAndTrack();

      const res = await client.api.terminals[":id"].exec.$post({
        param: { id: created.sessionId },
        json: { command: "echo hello-integration-test" },
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      if ("error" in data) throw new Error(`Unexpected error: ${data.error}`);
      expect(data.sessionId).toBe(created.sessionId);
      expect(data.output).toEqual(expect.stringContaining("hello-integration-test"));
      expect(data.exitCode).toBe(0);
    });

    it("returns the exit code of a failing command", async () => {
      const { data: created } = await createAndTrack();

      const res = await client.api.terminals[":id"].exec.$post({
        param: { id: created.sessionId },
        json: { command: "false" },
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      if ("error" in data) throw new Error(`Unexpected error: ${data.error}`);
      expect(data.exitCode).toBe(1);
    });

    it("returns 404 for a non-existent session", async () => {
      const res = await client.api.terminals[":id"].exec.$post({
        param: { id: "fc_00000000" },
        json: { command: "echo test" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 for a closed session", async () => {
      const { data: created } = await createAndTrack();
      await client.api.terminals[":id"].$delete({ param: { id: created.sessionId } });

      const res = await client.api.terminals[":id"].exec.$post({
        param: { id: created.sessionId },
        json: { command: "echo test" },
      });
      expect(res.status).toBe(409);
    });
  });

  // ─── POST /api/terminals/exec ───

  describe("POST /api/terminals/exec", () => {
    it("auto-creates a session and executes a command", async () => {
      const res = await client.api.terminals.exec.$post({
        json: { command: "echo auto-create-test" },
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      if ("error" in data) throw new Error(`Unexpected error: ${data.error}`);
      expect(data.sessionId).toMatch(/^fc_[0-9a-f]{8}$/);
      expect(data.output).toEqual(expect.stringContaining("auto-create-test"));
      expect(data.exitCode).toBe(0);

      track(data.sessionId);
    });
  });

  // ─── POST /api/terminals/:id/exec/async ───

  describe("POST /api/terminals/:id/exec/async", () => {
    it("starts a command asynchronously", async () => {
      const { data: created } = await createAndTrack();

      const res = await client.api.terminals[":id"].exec.async.$post({
        param: { id: created.sessionId },
        json: { command: "echo async-test" },
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      if ("error" in data) throw new Error(`Unexpected error: ${data.error}`);
      expect(data.sessionId).toBe(created.sessionId);
      expect(data.status).toBe("running");
    });

    it("returns 404 for a non-existent session", async () => {
      const res = await client.api.terminals[":id"].exec.async.$post({
        param: { id: "fc_00000000" },
        json: { command: "echo test" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 for a closed session", async () => {
      const { data: created } = await createAndTrack();
      await client.api.terminals[":id"].$delete({ param: { id: created.sessionId } });

      const res = await client.api.terminals[":id"].exec.async.$post({
        param: { id: created.sessionId },
        json: { command: "echo test" },
      });
      expect(res.status).toBe(409);
    });
  });

  // ─── POST /api/terminals/exec/async ───

  describe("POST /api/terminals/exec/async", () => {
    it("auto-creates a session and starts a command asynchronously", async () => {
      const res = await client.api.terminals.exec.async.$post({
        json: { command: "echo auto-async-test" },
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      if ("error" in data) throw new Error(`Unexpected error: ${data.error}`);
      expect(data.sessionId).toMatch(/^fc_[0-9a-f]{8}$/);
      expect(data.status).toBe("running");

      track(data.sessionId);
    });
  });

  // ─── POST /api/terminals/:id/input ───

  describe("POST /api/terminals/:id/input", () => {
    it("sends text input to a session", async () => {
      const { data: created } = await createAndTrack();

      const res = await client.api.terminals[":id"].input.$post({
        param: { id: created.sessionId },
        json: { text: "echo input-test" },
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      if ("error" in data) throw new Error(`Unexpected error: ${data.error}`);
      expect(data.sessionId).toBe(created.sessionId);
      expect(data.sent).toBe(true);
    });

    it("sends key sequences to a session", async () => {
      const { data: created } = await createAndTrack();

      const res = await client.api.terminals[":id"].input.$post({
        param: { id: created.sessionId },
        json: { keys: ["enter"] },
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      if ("error" in data) throw new Error(`Unexpected error: ${data.error}`);
      expect(data.sent).toBe(true);
    });

    it("returns 404 for a non-existent session", async () => {
      const res = await client.api.terminals[":id"].input.$post({
        param: { id: "fc_00000000" },
        json: { text: "hello" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 for a closed session", async () => {
      const { data: created } = await createAndTrack();
      await client.api.terminals[":id"].$delete({ param: { id: created.sessionId } });

      const res = await client.api.terminals[":id"].input.$post({
        param: { id: created.sessionId },
        json: { text: "hello" },
      });
      expect(res.status).toBe(409);
    });
  });

  // ─── Session lifecycle ───

  describe("session lifecycle", () => {
    it("create → exec → get output → close", async () => {
      // 1. Create
      const { data: created } = await createAndTrack();
      expect(created.sessionId).toBeTruthy();

      // 2. Execute a command
      const execRes = await client.api.terminals[":id"].exec.$post({
        param: { id: created.sessionId },
        json: { command: "echo lifecycle-test-output" },
      });
      const execData = await execRes.json();
      if ("error" in execData) throw new Error(`Unexpected error: ${execData.error}`);
      expect(execData.exitCode).toBe(0);
      expect(execData.output).toEqual(expect.stringContaining("lifecycle-test-output"));

      // 3. Get session — should still be running
      const getRes = await client.api.terminals[":id"].$get({
        param: { id: created.sessionId },
        query: {},
      });
      const getData = await getRes.json();
      if ("error" in getData) throw new Error(`Unexpected error: ${getData.error}`);
      expect(getData.status).toBe("running");

      // 4. Close
      const closeRes = await client.api.terminals[":id"].$delete({
        param: { id: created.sessionId },
      });
      const closeData = await closeRes.json();
      if ("error" in closeData) throw new Error(`Unexpected error: ${closeData.error}`);
      expect(closeData.status).toBe("closed");
      expect(closeData.finalOutput).toEqual(expect.any(String));

      // 5. Verify closed session returns 409 on exec
      const postCloseRes = await client.api.terminals[":id"].exec.$post({
        param: { id: created.sessionId },
        json: { command: "echo should-fail" },
      });
      expect(postCloseRes.status).toBe(409);
    });

    it("session appears in list after creation and reflects closed status", async () => {
      const { data: created } = await createAndTrack();

      // Should appear in list as running
      const listRes1 = await client.api.terminals.$get();
      const listData1 = await listRes1.json();
      const found1 = listData1.sessions.find((s) => s.sessionId === created.sessionId);
      expect(found1).toBeDefined();
      expect(found1?.status).toBe("running");

      // Close it
      await client.api.terminals[":id"].$delete({ param: { id: created.sessionId } });

      // Should still appear but as closed
      const listRes2 = await client.api.terminals.$get();
      const listData2 = await listRes2.json();
      const found2 = listData2.sessions.find((s) => s.sessionId === created.sessionId);
      expect(found2).toBeDefined();
      expect(found2?.status).toBe("closed");
    });
  });

  // ─── Root endpoint ───

  describe("GET /", () => {
    it("returns health check", async () => {
      const res = await client.index.$get();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.name).toBe("flamecast");
      expect(data.status).toBe("ok");
    });
  });
});
