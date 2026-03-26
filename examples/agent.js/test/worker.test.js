import { describe, expect, test } from "vitest";
import { buildDynamicWorkerCode } from "../src/dynamic-worker-code.js";

describe("dynamic worker code", () => {
  test("builds a valid WorkerCode payload for the loader binding", () => {
    const code = buildDynamicWorkerCode("return 1;");

    expect(code).toMatchObject({
      compatibilityDate: "2026-03-25",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "execute-js.js",
    });
    expect(code.modules).toEqual({
      "execute-js.js": expect.stringContaining("export default"),
    });
  });
});
