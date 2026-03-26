import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock("ai");
  vi.doUnmock("ai-gateway-provider");
  vi.doUnmock("ai-gateway-provider/providers/unified");
});

function mockGatewayDeps({
  generateText = vi.fn(),
  streamText = vi.fn(),
  createUnified,
} = {}) {
  vi.resetModules();
  vi.doMock("ai", () => ({ generateText, streamText }));
  if (createUnified) {
    vi.doMock("ai-gateway-provider/providers/unified", () => ({ createUnified }));
  }
  return { generateText, streamText, createUnified };
}

describe("gateway model helpers", () => {
  test("wraps the unified gateway model through AI Gateway", async () => {
    const generateText = vi.fn().mockResolvedValue({ text: "ok" });
    mockGatewayDeps({ generateText });

    const { getGatewayModel } = await import("../src/gateway-model.js");
    const model = await getGatewayModel({
      CF_ACCOUNT_ID: "acct",
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_TOKEN: "token",
      CF_AI_MODEL: "openai/gpt-5.4",
    });

    expect(model).not.toBeNull();

    await model.generateText({ prompt: "hi" });

    expect(generateText).toHaveBeenCalledWith({
      prompt: "hi",
      model: expect.anything(),
    });
  });

  test("returns null when gateway env is incomplete", async () => {
    mockGatewayDeps();
    const { getGatewayModel } = await import("../src/gateway-model.js");
    await expect(getGatewayModel({})).resolves.toBeNull();
  });

  test("passes an OpenAI API key to the unified provider when present", async () => {
    const generateText = vi.fn().mockResolvedValue({ text: "ok" });
    const createUnifiedCalls = [];

    mockGatewayDeps({
      generateText,
      createUnified: (options) => {
        createUnifiedCalls.push(options);
        return vi.fn((modelId) => ({ modelId }));
      },
    });

    const { getGatewayModel } = await import("../src/gateway-model.js");
    const model = await getGatewayModel({
      CF_ACCOUNT_ID: "acct",
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_TOKEN: "token",
      CF_AI_MODEL: "openai/gpt-5.4",
      OPENAI_API_KEY: "openai-key",
    });

    await model.generateText({ prompt: "hi" });

    expect(createUnifiedCalls).toEqual([{ apiKey: "openai-key" }]);
    expect(generateText).toHaveBeenCalledWith({ prompt: "hi", model: expect.anything() });
  });

  test("generateGatewayText falls back to null when inference fails", async () => {
    const generateText = vi.fn().mockRejectedValue(new Error("gateway down"));
    mockGatewayDeps({ generateText });

    const { generateGatewayText } = await import("../src/gateway-model.js");
    await expect(
      generateGatewayText(
        {
          CF_ACCOUNT_ID: "acct",
          CF_AI_GATEWAY: "gateway",
          CF_AI_GATEWAY_TOKEN: "token",
          CF_AI_MODEL: "openai/gpt-5.4",
        },
        { prompt: "hi" },
      ),
    ).resolves.toBeNull();
  });

  test("streamGatewayText wraps AI Gateway streaming", async () => {
    const streamResult = { textStream: ["ok"] };
    const streamText = vi.fn().mockReturnValue(streamResult);

    mockGatewayDeps({
      generateText: vi.fn(),
      streamText,
      createUnified: () => vi.fn((modelId) => ({ modelId })),
    });

    const { streamGatewayText } = await import("../src/gateway-model.js");
    const result = await streamGatewayText(
      {
        CF_ACCOUNT_ID: "acct",
        CF_AI_GATEWAY: "gateway",
        CF_AI_GATEWAY_TOKEN: "token",
        CF_AI_MODEL: "openai/gpt-5.4",
      },
      { prompt: "hi" },
    );

    expect(result).toBe(streamResult);
    expect(streamText).toHaveBeenCalledWith({ prompt: "hi", model: expect.anything() });
  });
});
