import { describe, expect, test } from "vitest";
import {
  estimateTokenCount,
  getCompactionThresholdTokens,
  getMaxContextTokens,
  shouldCompactSession,
} from "../src/compaction.js";
import { buildDynamicWorkerCode } from "../src/dynamic-worker-code.js";

describe("dynamic worker code", () => {
  test("builds a valid WorkerCode payload for the loader binding", () => {
    const code = buildDynamicWorkerCode("return 1;");

    expect(code).toMatchObject({
      compatibilityDate: "2026-03-24",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "execute-js.js",
    });
    expect(code.modules).toEqual({
      "execute-js.js": expect.stringContaining("export default"),
    });
  });
});

describe("compaction thresholds", () => {
  test("defaults gpt-5.4 to an 80% threshold of its context window", () => {
    expect(getMaxContextTokens({ CF_AI_MODEL: "openai/gpt-5.4" })).toBe(1_050_000);
    expect(getCompactionThresholdTokens({ CF_AI_MODEL: "openai/gpt-5.4" })).toBe(840_000);
  });

  test("uses token estimates instead of raw character counts to decide compaction", () => {
    const session = {
      summary: "",
      transcript: [
        { role: "user", text: "a".repeat(3_400_000) },
        { role: "assistant", text: "ok" },
        { role: "assistant", text: "recent" },
        { role: "assistant", text: "recent" },
        { role: "assistant", text: "recent" },
        { role: "assistant", text: "recent" },
        { role: "assistant", text: "recent" },
        { role: "assistant", text: "recent" },
      ],
    };

    expect(estimateTokenCount("abcd")).toBe(1);
    expect(shouldCompactSession({ CF_AI_MODEL: "openai/gpt-5.4" }, session)).toBe(true);
  });
});
