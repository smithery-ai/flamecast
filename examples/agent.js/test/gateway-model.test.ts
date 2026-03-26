import { beforeEach, describe, expect, test, vi } from "vitest";
import { generateGatewayText, getGatewayModel, streamGatewayText } from "../src/gateway-model.js";

const generateTextMock = vi.fn();
const streamTextMock = vi.fn();
const createAiGatewayMock = vi.fn();
const createUnifiedMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args) => generateTextMock(...args),
  streamText: (...args) => streamTextMock(...args),
}));

vi.mock("ai-gateway-provider", () => ({
  createAiGateway: (...args) => createAiGatewayMock(...args),
}));

vi.mock("ai-gateway-provider/providers/unified", () => ({
  createUnified: (...args) => createUnifiedMock(...args),
}));

beforeEach(() => {
  generateTextMock.mockReset();
  streamTextMock.mockReset();
  createAiGatewayMock.mockReset().mockImplementation(() => (model) => model);
  createUnifiedMock.mockReset().mockImplementation(() => (modelId) => ({ modelId }));
});

describe("gateway model helpers", () => {
  test("wraps the unified gateway model through AI Gateway", async () => {
    generateTextMock.mockResolvedValue({ text: "ok" });

    const model = await getGatewayModel({
      CF_ACCOUNT_ID: "acct",
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_TOKEN: "token",
      CF_AI_MODEL: "openai/gpt-5.4",
    });

    expect(model).not.toBeNull();

    await model.generateText({ prompt: "hi" });

    expect(generateTextMock).toHaveBeenCalledWith({
      prompt: "hi",
      model: expect.anything(),
    });
  });

  test("returns null when gateway env is incomplete", async () => {
    await expect(getGatewayModel({})).resolves.toBeNull();
  });

  test("passes an OpenAI API key to the unified provider when present", async () => {
    generateTextMock.mockResolvedValue({ text: "ok" });

    const createUnifiedCalls = [];
    createUnifiedMock.mockImplementation((options) => {
      createUnifiedCalls.push(options);
      return (modelId) => ({ modelId });
    });

    const model = await getGatewayModel({
      CF_ACCOUNT_ID: "acct",
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_TOKEN: "token",
      CF_AI_MODEL: "openai/gpt-5.4",
      OPENAI_API_KEY: "openai-key",
    });

    await model.generateText({ prompt: "hi" });

    expect(createUnifiedCalls).toEqual([{ apiKey: "openai-key" }]);
    expect(generateTextMock).toHaveBeenCalledWith({ prompt: "hi", model: expect.anything() });
  });

  test("generateGatewayText falls back to null when inference fails", async () => {
    generateTextMock.mockRejectedValue(new Error("gateway down"));

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
    streamTextMock.mockReturnValue(streamResult);

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
    expect(streamTextMock).toHaveBeenCalledWith({ prompt: "hi", model: expect.anything() });
  });
});
