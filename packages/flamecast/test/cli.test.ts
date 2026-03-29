import { describe, expect, it } from "vitest";
import { createDrizzleStudioConfig, parseDbArgs, parsePort } from "../src/node/cli.js";

describe("flamecast cli helpers", () => {
  it("parses db-specific options and forwards the rest", () => {
    expect(
      parseDbArgs(["--url", "postgres://db/flamecast", "--port", "4999", "--verbose"]),
    ).toEqual({
      options: { url: "postgres://db/flamecast" },
      passthrough: ["--port", "4999", "--verbose"],
    });

    expect(parseDbArgs(["--data-dir=/tmp/flamecast-db"])).toEqual({
      options: { dataDir: "/tmp/flamecast-db" },
      passthrough: [],
    });
  });

  it("builds a drizzle studio config for postgres", () => {
    const config = createDrizzleStudioConfig({ url: "postgres://db/flamecast" });

    expect(config).toContain('dialect: "postgresql"');
    expect(config).toContain("schema:");
    expect(config).toContain("out:");
    expect(config).toContain('dbCredentials: { url: "postgres://db/flamecast" }');
  });

  it("builds a drizzle studio config for pglite", () => {
    const config = createDrizzleStudioConfig({ dataDir: "/tmp/flamecast-db" });

    expect(config).toContain('driver: "pglite"');
    expect(config).toContain('dbCredentials: { url: "/tmp/flamecast-db" }');
  });

  it("validates port values", () => {
    expect(parsePort(undefined)).toBe(3001);
    expect(parsePort("4010")).toBe(4010);
    expect(() => parsePort("0")).toThrow('Invalid port "0"');
  });
});
