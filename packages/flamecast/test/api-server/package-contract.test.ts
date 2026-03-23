import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const PackageJsonSchema = z.object({
  name: z.string(),
  main: z.string(),
  types: z.string(),
  exports: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())])),
  bin: z.record(z.string(), z.string()),
  files: z.array(z.string()),
});

describe("package contract", () => {
  it("exports the public flamecast package surface and CLI", async () => {
    const packageJsonPath = new URL("../../package.json", import.meta.url);
    const packageJson = PackageJsonSchema.parse(
      JSON.parse(await readFile(packageJsonPath, "utf8")),
    );

    expect(packageJson.name).toBe("@flamecast/sdk");
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.bin.flamecast).toBe("./dist/cli.js");
    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(packageJson.exports["./api"]).toEqual({
      types: "./dist/flamecast/api.d.ts",
      import: "./dist/flamecast/api.js",
    });
    expect(packageJson.exports["./client"]).toEqual({
      types: "./dist/client/api.d.ts",
      import: "./dist/client/api.js",
    });
    expect(packageJson.exports["./worker"]).toEqual({
      types: "./dist/worker.d.ts",
      import: "./dist/worker.js",
    });

    const entry = await import("../../src/index.js");
    expect(entry.Flamecast).toBeTypeOf("function");
  });
});
