const defaultProxyBase = "http://127.0.0.1:3001/api/integrations/proxy";

function hasValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export interface IntegrationConfig {
  botName: string;
  brokerEncryptionKey: string | null;
  enabled: boolean;
  linear: {
    accessToken: string | null;
    clientId: string | null;
    clientSecret: string | null;
    webhookSecret: string | null;
    enabled: boolean;
  };
  postgresUrl: string | null;
  proxyBaseUrl: string;
  slack: {
    clientId: string | null;
    clientSecret: string | null;
    encryptionKey: string | null;
    signingSecret: string | null;
    enabled: boolean;
  };
}

let cachedConfig: IntegrationConfig | null = null;

export function getIntegrationConfig(): IntegrationConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const postgresUrl = process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? null;
  const brokerEncryptionKey = process.env.FLAMECAST_BROKER_ENCRYPTION_KEY ?? null;
  const slack = {
    clientId: process.env.SLACK_CLIENT_ID ?? null,
    clientSecret: process.env.SLACK_CLIENT_SECRET ?? null,
    encryptionKey: process.env.SLACK_ENCRYPTION_KEY ?? brokerEncryptionKey,
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? null,
    enabled:
      hasValue(process.env.SLACK_SIGNING_SECRET) &&
      hasValue(process.env.SLACK_CLIENT_ID) &&
      hasValue(process.env.SLACK_CLIENT_SECRET),
  };
  const linear = {
    accessToken: process.env.LINEAR_ACCESS_TOKEN ?? process.env.LINEAR_API_KEY ?? null,
    clientId: process.env.LINEAR_CLIENT_ID ?? null,
    clientSecret: process.env.LINEAR_CLIENT_SECRET ?? null,
    webhookSecret: process.env.LINEAR_WEBHOOK_SECRET ?? null,
    enabled:
      hasValue(process.env.LINEAR_WEBHOOK_SECRET) &&
      (hasValue(process.env.LINEAR_ACCESS_TOKEN) ||
        hasValue(process.env.LINEAR_API_KEY) ||
        (hasValue(process.env.LINEAR_CLIENT_ID) && hasValue(process.env.LINEAR_CLIENT_SECRET))),
  };

  cachedConfig = {
    botName: process.env.FLAMECAST_BOT_NAME?.trim() || "flamecast",
    brokerEncryptionKey,
    enabled: hasValue(postgresUrl),
    linear,
    postgresUrl,
    proxyBaseUrl: process.env.FLAMECAST_PROXY_BASE_URL?.trim() || defaultProxyBase,
    slack,
  };

  return cachedConfig;
}
