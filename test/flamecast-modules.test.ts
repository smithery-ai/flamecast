import path from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";
import { PSQL_MIGRATIONS_FOLDER } from "../src/flamecast/storage/psql/migrations-path.js";
import drizzleConfig from "../src/flamecast/storage/psql/drizzle.config.js";
import { sessionLogs, sessions } from "../src/flamecast/storage/psql/schema.js";

function createSessionMeta(id: string) {
  return {
    id,
    agentId: "agent-1",
    agentName: "Example agent",
    spawn: { command: "node", args: ["agent.js"] },
    cwd: process.cwd(),
    startedAt: "2024-01-01T00:00:00.000Z",
    lastUpdatedAt: "2024-01-01T00:00:00.000Z",
    pendingPermission: null,
  };
}

describe("memory storage", () => {
  test("stores sessions and logs with the expected error handling", async () => {
    const storage = new MemoryFlamecastStorage();
    const meta = createSessionMeta("session-1");

    await expect(storage.updateSession("missing", {})).rejects.toThrow(
      'Session "missing" not found in storage',
    );
    await expect(
      storage.appendLog("missing", { timestamp: "t", type: "rpc", data: {} }),
    ).rejects.toThrow('Session "missing" has no log stream');

    await storage.createSession(meta);
    await storage.updateSession(meta.id, { lastUpdatedAt: "2024-01-02T00:00:00.000Z" });
    await storage.updateSession(meta.id, {
      pendingPermission: {
        requestId: "request-1",
        toolCallId: "tool-1",
        title: "Approve",
        options: [],
      },
    });
    await storage.appendLog(meta.id, {
      timestamp: "2024-01-02T00:00:00.000Z",
      type: "rpc",
      data: { ok: true },
    });

    expect(await storage.getSessionMeta(meta.id)).toMatchObject({
      lastUpdatedAt: "2024-01-02T00:00:00.000Z",
      pendingPermission: {
        requestId: "request-1",
      },
    });
    expect(await storage.getLogs(meta.id)).toEqual([
      {
        timestamp: "2024-01-02T00:00:00.000Z",
        type: "rpc",
        data: { ok: true },
      },
    ]);

    await storage.finalizeSession(meta.id, "terminated");
    expect(await storage.getSessionMeta(meta.id)).toBeNull();
    expect(await storage.getLogs(meta.id)).toEqual([]);
  });
});

describe("psql module metadata", () => {
  test("exports schema and drizzle metadata", async () => {
    const psqlTypes = await import("../src/flamecast/storage/psql/types.js");
    const [sessionLogForeignKey] = getTableConfig(sessionLogs).foreignKeys;

    expect(sessions).toBeDefined();
    expect(sessionLogs).toBeDefined();
    expect(getTableConfig(sessionLogs).foreignKeys).toHaveLength(1);
    expect(sessionLogForeignKey?.reference().foreignTable).toBe(sessions);
    expect(path.basename(PSQL_MIGRATIONS_FOLDER)).toBe("migrations");
    expect(drizzleConfig).toMatchObject({
      schema: "./src/flamecast/storage/psql/schema.ts",
      out: "./src/flamecast/storage/psql/migrations",
      dialect: "postgresql",
    });
    expect(psqlTypes).toBeTypeOf("object");
  });
});
