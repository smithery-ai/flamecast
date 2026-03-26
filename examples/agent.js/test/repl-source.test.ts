import { describe, expect, test } from "vitest";
import { makeReplFriendlySource, prepareExecuteJsSource } from "../src/repl-source.js";

describe("makeReplFriendlySource", () => {
  test("returns expression-only input automatically", () => {
    expect(makeReplFriendlySource("5 + 2")).toContain("return (\n5 + 2\n);");
  });

  test("returns the final expression after statements", () => {
    expect(makeReplFriendlySource("const x = 1;\nx + 2")).toContain("return (x + 2);");
  });

  test("preserves explicit return statements", () => {
    expect(makeReplFriendlySource("const x = 1;\nreturn x + 2;")).toBe(
      "const x = 1;\nreturn x + 2;",
    );
  });

  test("allows nested function returns and still returns the final expression", () => {
    expect(makeReplFriendlySource("function add() { return 7; }\nadd()")).toContain(
      "return (add());",
    );
  });

  test("returns the value of a final declaration after persistent binding rewrite", () => {
    expect(prepareExecuteJsSource("const now = new Date().toISOString();")).toBe(
      "return (\nscope.now = new Date().toISOString()\n);",
    );
  });
});
