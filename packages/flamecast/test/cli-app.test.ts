import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-app.js";

describe("cli command parsing", () => {
  it("defaults to serve with no arguments", () => {
    expect(parseCliArgs([])).toEqual({
      kind: "serve",
      flags: {},
    });
  });

  it("parses db migrate and studio subcommands", () => {
    expect(
      parseCliArgs([
        "db",
        "migrate",
        "--config",
        "./flamecast.config.ts",
        "--url",
        "postgres://db/flamecast",
      ]),
    ).toEqual({
      kind: "db-migrate",
      flags: {
        config: "./flamecast.config.ts",
        url: "postgres://db/flamecast",
      },
    });

    expect(
      parseCliArgs(["db", "studio", "--data-dir", ".flamecast/pglite", "--port", "4999"]),
    ).toEqual({
      kind: "db-studio",
      flags: {
        dataDir: ".flamecast/pglite",
        port: "4999",
      },
    });
  });

  it("treats --help as help", () => {
    expect(parseCliArgs(["--help"])).toEqual({
      kind: "help",
    });
  });

  it("rejects unknown commands", () => {
    expect(() => parseCliArgs(["db", "unknown"])).toThrow('Unknown db subcommand "unknown"');
  });
});
