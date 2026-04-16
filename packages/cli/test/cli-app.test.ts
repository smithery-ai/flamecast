import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-app.js";

describe("parseCliArgs", () => {
  it("parses down --deregister", () => {
    expect(parseCliArgs(["down", "--deregister"])).toEqual({
      kind: "down",
      flags: { deregister: true },
    });
  });

  it("parses up flags", () => {
    expect(parseCliArgs(["up", "--name", "anirudh", "--port", "4000"])).toEqual({
      kind: "up",
      flags: { name: "anirudh", port: 4000 },
    });
  });
});
