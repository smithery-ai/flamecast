import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDatabaseReady,
  createDatabase,
  getMigrationStatus,
  migrateDatabase,
} from "../src/db.js";
import { createPsqlDatabase, createPsqlStorage } from "../src/index.js";

describe("explicit migration flow", () => {
  it("reports pending migrations for a fresh database and becomes ready after migrate", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "flamecast-migrations-"));
    const bundle = await createDatabase({ dataDir });

    try {
      const initialStatus = await getMigrationStatus(bundle);

      expect(initialStatus.isUpToDate).toBe(false);
      expect(initialStatus.applied).toHaveLength(0);
      expect(initialStatus.pending.length).toBeGreaterThan(0);
      await expect(assertDatabaseReady(bundle)).rejects.toThrow("flamecast db migrate");

      const result = await migrateDatabase(bundle);

      expect(result.applied.length).toBe(initialStatus.pending.length);
      expect(result.status.isUpToDate).toBe(true);
      expect(result.status.pending).toHaveLength(0);
      await expect(assertDatabaseReady(bundle)).resolves.toMatchObject({
        isUpToDate: true,
      });
    } finally {
      await bundle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("fails fast when storage is opened before migrations are applied", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "flamecast-storage-ready-"));

    try {
      await expect(createPsqlStorage({ dataDir, seedDefaults: false })).rejects.toThrow(
        "flamecast db migrate",
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("exposes a reusable db helper for config-driven migrations", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "flamecast-db-helper-"));
    const db = createPsqlDatabase({ dataDir });

    try {
      const initialStatus = await db.getMigrationStatus();
      expect(initialStatus.isUpToDate).toBe(false);

      const result = await db.migrate();
      expect(result.status.isUpToDate).toBe(true);

      const storage = await db.createStorage({ seedDefaults: false });
      await expect(storage.listAgentTemplates()).resolves.toEqual([]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
