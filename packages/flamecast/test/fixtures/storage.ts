import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import type { FlamecastStorage } from "../../src/flamecast/storage.js";
import { createDatabase } from "../../../flamecast-psql/src/db.js";
import { createStorageFromDb } from "../../../flamecast-psql/src/storage.js";

export async function createTestStorage(): Promise<FlamecastStorage> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "flamecast-test-storage-"));
  const { db, close } = await createDatabase({ dataDir });
  const storage = createStorageFromDb(db);

  onTestFinished(async () => {
    await close();
    await rm(dataDir, { recursive: true, force: true });
  });

  return storage;
}
