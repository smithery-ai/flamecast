import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDatabase } from "../../src/flamecast/db/client.js";

const PackageJsonSchema = z.object({
  name: z.string(),
  exports: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())])),
  bin: z.record(z.string(), z.string()),
});

describe("package contract", () => {
  it("exports the public flamecast package surface", async () => {
    const packageJsonPath = new URL("../../package.json", import.meta.url);
    const packageJson = PackageJsonSchema.parse(
      JSON.parse(await readFile(packageJsonPath, "utf8")),
    );

    expect(packageJson.name).toBe("flamecast");
    expect(packageJson.bin.flamecast).toBe("./dist/cli.js");
    expect(packageJson.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });

    const entry = await import("../../src/index.js");
    expect(entry.Flamecast).toBeTypeOf("function");
  });

  it("uses the flamecast-branded pglite directory env var", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "flamecast-pglite-env-"));
    const previousDir = process.env.FLAMECAST_PGLITE_DIR;
    const previousLegacyDir = process.env.ACP_PGLITE_DIR;
    const previousPostgresUrl = process.env.FLAMECAST_POSTGRES_URL;

    delete process.env.FLAMECAST_POSTGRES_URL;
    process.env.FLAMECAST_PGLITE_DIR = dataDir;
    delete process.env.ACP_PGLITE_DIR;

    try {
      const { close } = await createDatabase();
      await close();

      const createdFiles = await readdir(dataDir);
      expect(createdFiles.length).toBeGreaterThan(0);
    } finally {
      if (previousDir === undefined) {
        delete process.env.FLAMECAST_PGLITE_DIR;
      } else {
        process.env.FLAMECAST_PGLITE_DIR = previousDir;
      }

      if (previousLegacyDir === undefined) {
        delete process.env.ACP_PGLITE_DIR;
      } else {
        process.env.ACP_PGLITE_DIR = previousLegacyDir;
      }

      if (previousPostgresUrl === undefined) {
        delete process.env.FLAMECAST_POSTGRES_URL;
      } else {
        process.env.FLAMECAST_POSTGRES_URL = previousPostgresUrl;
      }

      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
