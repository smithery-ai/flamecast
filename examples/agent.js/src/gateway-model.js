import { generateText, streamText } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";

export const DEFAULT_MODEL = "openai/gpt-5.4";

function warnGateway(message) {
  console.warn(`[agent.js] ${message}`);
}

export async function getGatewayModel(env) {
  const accountId = env.CF_ACCOUNT_ID;
  const gateway = env.CF_AI_GATEWAY;
  const token = env.CF_AI_GATEWAY_TOKEN;

  if (!accountId || !gateway || !token) {
    return null;
  }

  const aiGateway = createAiGateway({
    accountId,
    gateway,
    apiKey: token,
  });
  const unified = createUnified(
    env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : undefined,
  );
  const modelId = env.CF_AI_MODEL || DEFAULT_MODEL;

  return {
    generateText: (options) =>
      generateText({
        ...options,
        model: aiGateway(unified(modelId)),
      }),
    streamText: (options) =>
      streamText({
        ...options,
        model: aiGateway(unified(modelId)),
      }),
  };
}

export async function generateGatewayText(env, options) {
  const model = await getGatewayModel(env);
  if (!model) {
    if ((env.AGENT_MODE ?? "scripted") === "gateway") {
      warnGateway(
        "gateway mode is enabled, but CF_ACCOUNT_ID, CF_AI_GATEWAY, or CF_AI_GATEWAY_TOKEN is missing",
      );
    }
    return null;
  }

  try {
    const { text } = await model.generateText(options);
    return text;
  } catch (error) {
    if ((env.AGENT_MODE ?? "scripted") === "gateway") {
      warnGateway(
        `AI Gateway inference failed; falling back to scripted mode (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return null;
  }
}

export async function streamGatewayText(env, options) {
  const model = await getGatewayModel(env);
  if (!model) {
    if ((env.AGENT_MODE ?? "scripted") === "gateway") {
      warnGateway(
        "gateway mode is enabled, but CF_ACCOUNT_ID, CF_AI_GATEWAY, or CF_AI_GATEWAY_TOKEN is missing",
      );
    }
    return null;
  }

  try {
    return model.streamText(options);
  } catch (error) {
    if ((env.AGENT_MODE ?? "scripted") === "gateway") {
      warnGateway(
        `AI Gateway streaming failed; falling back to scripted mode (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return null;
  }
}
