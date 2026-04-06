import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCliTarget, resolveDatabaseSource } from "../src/cli-app.js";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_POSTGRES_URL = process.env.POSTGRES_URL;

afterEach(() => {
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }

  if (ORIGINAL_POSTGRES_URL === undefined) {
    delete process.env.POSTGRES_URL;
  } else {
    process.env.POSTGRES_URL = ORIGINAL_POSTGRES_URL;
  }
});

async function createTempConfig(contents: string): Promise<{ cwd: string; configPath: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "flamecast-cli-config-"));
  const configPath = path.join(cwd, "flamecast.config.ts");
  await writeFile(configPath, contents, "utf8");
  return { cwd, configPath };
}

describe("cli config loading", () => {
  it("loads db settings from an explicit config file", async () => {
    const { cwd, configPath } = await createTempConfig(
      'export default { db: { url: "postgres://config/flamecast" } };\n',
    );

    await expect(resolveDatabaseSource({ config: configPath }, cwd)).resolves.toEqual({
      kind: "options",
      db: {
        url: "postgres://config/flamecast",
      },
    });
  });

  it("auto-discovers flamecast.config.ts from the current working directory", async () => {
    const { cwd } = await createTempConfig(
      'export default { db: { url: "postgres://auto/flamecast" } };\n',
    );

    await expect(resolveDatabaseSource({}, cwd)).resolves.toEqual({
      kind: "options",
      db: {
        url: "postgres://auto/flamecast",
      },
    });
  });

  it("treats a config file as the source of truth instead of falling back to env vars", async () => {
    process.env.DATABASE_URL = "postgres://env/flamecast";
    const { cwd } = await createTempConfig("export default { db: {} };\n");

    await expect(resolveDatabaseSource({}, cwd)).resolves.toEqual({
      kind: "options",
      db: {},
    });
  });

  it("accepts a script-backed db export from config", async () => {
    const { cwd } = await createTempConfig(`
      const db = {
        kind: "psql",
        open: async () => ({ driver: "pglite", dataDir: "/tmp/test", db: {}, client: {}, close: async () => {} }),
        createStorage: async () => ({ seedAgentTemplates: async () => {} }),
        getMigrationStatus: async () => ({ applied: [], pending: [], current: null, latest: null, isUpToDate: true }),
        migrate: async () => ({ applied: [], status: { applied: [], pending: [], current: null, latest: null, isUpToDate: true } }),
        getStudioConfig: () => ({ dialect: "postgresql", driver: "pglite", schema: "schema.ts", dbCredentials: { url: "/tmp/test" } }),
      };
      export default { db };
    `);

    await expect(resolveDatabaseSource({}, cwd)).resolves.toMatchObject({
      kind: "script",
      db: {
        kind: "psql",
      },
    });
  });

  it("prefers an exported Flamecast instance from config discovery", async () => {
    const { cwd } = await createTempConfig(`
      export default {
        app: { fetch: () => new Response(null, { status: 200 }) },
        init: async () => {},
        close: async () => {},
        shutdown: async () => {},
        migrate: async () => ({ applied: [], status: { pending: [], current: null, isUpToDate: true } }),
        getMigrationStatus: async () => ({ pending: [], current: null, isUpToDate: true }),
        getStudioConfig: async () => ({ dialect: "postgresql" }),
      };
    `);

    await expect(resolveCliTarget({}, cwd)).resolves.toMatchObject({
      kind: "flamecast",
    });
  });

  it("fails fast when the config module does not export a flamecast config", async () => {
    const { cwd } = await createTempConfig("export const nope = true;\n");

    await expect(resolveDatabaseSource({}, cwd)).rejects.toThrow(
      "must export either a Flamecast instance",
    );
  });
});
