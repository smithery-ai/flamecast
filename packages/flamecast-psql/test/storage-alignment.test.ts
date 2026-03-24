import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db.js";
import { createStorageFromDb } from "../src/storage.js";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)("storage alignment", () => {
  it("stores managed and user templates in psql-backed storage", async () => {
    const { db, close } = await createDatabase({ url: TEST_DB_URL ?? "" });
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
        id: "user-custom",
        name: "User Custom",
        spawn: { command: "python", args: ["custom.py"] },
        runtime: { provider: "local" },
      });

      const templates = await storage.listAgentTemplates();
      const names = templates.map((t) => t.name);
      expect(names).toContain("Managed A");
      expect(names).toContain("Managed B");
      expect(names).toContain("User Custom");

      // Re-seed with only managed-a — managed-b should be pruned, user-custom preserved
      await storage.seedAgentTemplates([
        {
          id: "managed-a",
          name: "Managed A",
          spawn: { command: "node", args: ["managed-a.js"] },
          runtime: { provider: "local" },
        },
      ]);

      const afterReseed = await storage.listAgentTemplates();
      const afterNames = afterReseed.map((t) => t.name);
      expect(afterNames).toContain("Managed A");
      expect(afterNames).not.toContain("Managed B");
      expect(afterNames).toContain("User Custom");
    } finally {
      await close();
    }
  });

  it("stores sessions in the flamecast schema", async () => {
    const { db, close } = await createDatabase({ url: TEST_DB_URL ?? "" });
    const storage = createStorageFromDb(db);

    try {
      const now = new Date().toISOString();
      await storage.createSession({
        id: "test-session",
        agentName: "test-agent",
        spawn: { command: "echo", args: ["hello"] },
        startedAt: now,
        lastUpdatedAt: now,
        status: "active",
        pendingPermission: null,
      });

      const session = await storage.getSessionMeta("test-session");
      expect(session).toBeDefined();
      expect(session?.agentName).toBe("test-agent");

      await storage.finalizeSession("test-session", "terminated");
      const finalized = await storage.getSessionMeta("test-session");
      expect(finalized?.status).toBe("killed");
    } finally {
      await close();
    }
  });
});
