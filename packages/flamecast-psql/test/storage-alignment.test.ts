import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase, migrateDatabase } from "../src/db.js";
import { createStorageFromDb } from "../src/storage.js";

describe("storage alignment", () => {
  it("stores managed and user templates in pglite-backed storage", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "flamecast-storage-"));
    await migrateDatabase({ dataDir });
    const { db, close } = await createDatabase({ dataDir });
    const storage = createStorageFromDb(db);

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

  it("stores sessions in pglite-backed storage", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "flamecast-sessions-"));
    await migrateDatabase({ dataDir });
    const { db, close } = await createDatabase({ dataDir });
    const storage = createStorageFromDb(db);

    try {
      await storage.createSession({
        id: "session-1",
        agentName: "Example agent",
        spawn: { command: "node", args: ["agent.js"] },
        startedAt: "2026-03-21T00:00:00.000Z",
        lastUpdatedAt: "2026-03-21T00:00:00.000Z",
        status: "active",
        pendingPermission: null,
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

      expect(session?.agentName).toBe("Example agent");
      expect(new Date(session?.lastUpdatedAt ?? "").toISOString()).toBe("2026-03-21T00:00:02.000Z");
      expect(session?.pendingPermission?.requestId).toBe("request-1");

      expect(await storage.getSessionMeta("nonexistent")).toBeNull();

      const allBeforeKill = await storage.listAllSessions();
      expect(allBeforeKill).toHaveLength(1);
      expect(allBeforeKill[0]?.status).toBe("active");

      await storage.finalizeSession("session-1", "terminated");
      const finalized = await storage.getSessionMeta("session-1");
      expect(finalized?.status).toBe("killed");

      const allAfterKill = await storage.listAllSessions();
      expect(allAfterKill).toHaveLength(1);
      expect(allAfterKill[0]?.status).toBe("killed");
    } finally {
      await close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("lists runtime instances oldest first", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "flamecast-runtime-instances-"));
    await migrateDatabase({ dataDir });
    const { db, close } = await createDatabase({ dataDir });
    const storage = createStorageFromDb(db);

    try {
      await storage.saveRuntimeInstance({
        name: "alpha",
        typeName: "docker",
        status: "running",
        websocketUrl: "ws://localhost:9001/",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await storage.saveRuntimeInstance({
        name: "beta",
        typeName: "docker",
        status: "running",
      });
      await storage.saveRuntimeInstance({
        name: "alpha",
        typeName: "docker",
        status: "paused",
        websocketUrl: "ws://localhost:9002/",
      });

      const instances = await storage.listRuntimeInstances();

      expect(instances.map((instance) => instance.name)).toEqual(["alpha", "beta"]);
      expect(instances.map((instance) => instance.status)).toEqual(["paused", "running"]);
      expect(instances[0]?.websocketUrl).toBe("ws://localhost:9002/");
      expect(instances[1]?.websocketUrl).toBeUndefined();
    } finally {
      await close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
