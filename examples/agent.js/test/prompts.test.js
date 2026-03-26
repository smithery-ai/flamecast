import { describe, expect, test } from "vitest";
import { DEFAULT_ASSISTANT_REPLY, EXECUTE_JS_TOOL_DESCRIPTION } from "../src/prompts.js";

describe("agent prompts", () => {
  test("documents fetch and outbound web access in the executeJS tool contract", () => {
    expect(EXECUTE_JS_TOOL_DESCRIPTION).toContain("fetch");
    expect(EXECUTE_JS_TOOL_DESCRIPTION).toContain("virtual filesystem");
    expect(EXECUTE_JS_TOOL_DESCRIPTION).toContain("Do not claim network access is blocked");
  });

  test("mentions fetch in the fallback assistant reply", () => {
    expect(DEFAULT_ASSISTANT_REPLY).toContain("fetch");
    expect(DEFAULT_ASSISTANT_REPLY).toContain("external web access");
  });
});
