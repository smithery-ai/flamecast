import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Flamecast } from "../../src/flamecast/index.js";
import { createDatabase } from "../../src/flamecast/db/client.js";
import { MemoryFlamecastStorage } from "../../src/flamecast/state-managers/memory/index.js";
import { createPsqlStorage } from "../../src/flamecast/state-managers/psql/index.js";

describe("storage alignment", () => {
  it("persists registered agent templates through Flamecast storage", async () => {
    const storage = new MemoryFlamecastStorage();
    const flamecastA = new Flamecast({ storage });

    const template = await flamecastA.registerAgentTemplate({
      name: "Persistent template",
      spawn: { command: "node", args: ["agent.js"] },
    });

    const flamecastB = new Flamecast({ storage });
    const templates = await flamecastB.listAgentTemplates();

    expect(templates.find((entry) => entry.id === template.id)).toEqual(template);
    expect(templates.find((entry) => entry.id === "example")).toBeDefined();
  });

  it("stores managed and user templates in pglite-backed storage", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "flamecast-storage-"));
    const { db, close } = await createDatabase({ pgliteDataDir: dataDir });
    const storage = createPsqlStorage(db);

    try {
      await storage.seedAgentTemplates([
        {
          id: "managed-a",
          name: "Managed A",
          spawn: { command: "node", args: ["managed-a.js"] },
          runtime: { provider: "local" },
        },
        {
          id: "managed-b",
          name: "Managed B",
          spawn: { command: "node", args: ["managed-b.js"] },
          runtime: { provider: "local" },
        },
      ]);

      await storage.saveAgentTemplate({
        id: "user-a",
        name: "User A",
        spawn: { command: "node", args: ["user-a.js"] },
        runtime: { provider: "local" },
      });

      await storage.seedAgentTemplates([
        {
          id: "managed-a",
          name: "Managed A (updated)",
          spawn: { command: "node", args: ["managed-a-v2.js"] },
          runtime: { provider: "local" },
        },
      ]);

      const templates = await storage.listAgentTemplates();
      const managedTemplate = await storage.getAgentTemplate("managed-a");
      const missingTemplate = await storage.getAgentTemplate("missing-template");

      expect(templates.map((template) => template.id)).toEqual(["managed-a", "user-a"]);
      expect(templates.find((template) => template.id === "managed-a")?.name).toBe(
        "Managed A (updated)",
      );
      expect(templates.find((template) => template.id === "managed-b")).toBeUndefined();
      expect(managedTemplate?.spawn.args).toEqual(["managed-a-v2.js"]);
      expect(missingTemplate).toBeNull();

      await storage.seedAgentTemplates([]);
      expect(await storage.listAgentTemplates()).toEqual([
        {
          id: "user-a",
          name: "User A",
          spawn: { command: "node", args: ["user-a.js"] },
          runtime: { provider: "local" },
        },
      ]);
    } finally {
      await close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("stores sessions and logs in the renamed pglite schema", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "flamecast-sessions-"));
    const { db, close } = await createDatabase({ pgliteDataDir: dataDir });
    const storage = createPsqlStorage(db);

    try {
      await storage.createAgent({
        id: "agent-1",
        agentName: "Example agent",
        spawn: { command: "node", args: ["agent.js"] },
        runtime: { provider: "local" },
        startedAt: "2026-03-21T00:00:00.000Z",
        lastUpdatedAt: "2026-03-21T00:00:00.000Z",
        latestSessionId: "session-1",
        sessionCount: 1,
      });

      await storage.createSession({
        id: "session-1",
        agentId: "agent-1",
        agentName: "Example agent",
        spawn: { command: "node", args: ["agent.js"] },
        cwd: "/tmp/flamecast",
        startedAt: "2026-03-21T00:00:00.000Z",
        lastUpdatedAt: "2026-03-21T00:00:00.000Z",
        pendingPermission: null,
      });

      await storage.appendLog("session-1", {
        timestamp: "2026-03-21T00:00:01.000Z",
        type: "rpc",
        data: { method: "session/new" },
      });
      await storage.updateSession("session-1", {});
      await storage.updateSession("session-1", {
        lastUpdatedAt: "2026-03-21T00:00:02.000Z",
        pendingPermission: {
          requestId: "request-1",
          toolCallId: "tool-1",
          title: "Approve",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });

      const session = await storage.getSessionMeta("session-1");
      const logs = await storage.getLogs("session-1");

      expect(session?.agentName).toBe("Example agent");
      expect(new Date(session?.lastUpdatedAt ?? "").toISOString()).toBe("2026-03-21T00:00:02.000Z");
      expect(session?.pendingPermission?.requestId).toBe("request-1");
      expect(logs).toHaveLength(1);
      expect(logs[0]?.type).toBe("rpc");
      expect(logs[0]?.data).toEqual({ method: "session/new" });
      expect(logs[0]?.timestamp).toBeTruthy();

      await storage.finalizeSession("session-1", "terminated");
      await expect(storage.getSessionMeta("session-1")).resolves.toBeNull();
    } finally {
      await close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
