import { describe, expect, test } from "vitest";
import { createBindings } from "../src/miniflare.js";

describe("miniflare bindings", () => {
  test("defaults local dev to gateway when a gateway token is present", () => {
    const bindings = createBindings({
      CF_AI_GATEWAY_TOKEN: "token",
    });

    expect(bindings.AGENT_MODE).toBe("gateway");
    expect(bindings.CF_ACCOUNT_ID).toBe("c4cf21d8a5e8878bc3c92708b1f80193");
    expect(bindings.CF_AI_GATEWAY).toBe("smithery-agent");
    expect(bindings.CF_AI_MODEL).toBe("openai/gpt-5.4");
  });
});
