import { getIntegrationConfig } from "./config.js";

interface LinearTokenCache {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: LinearTokenCache | null = null;

function getLinearScope(): string {
  return process.env.LINEAR_APP_SCOPES?.trim() || "read,write,comments:create";
}

export async function getLinearAccessToken(): Promise<string | null> {
  const config = getIntegrationConfig();
  if (config.linear.accessToken) {
    return config.linear.accessToken;
  }
  if (!(config.linear.clientId && config.linear.clientSecret)) {
    return null;
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    client_id: config.linear.clientId,
    client_secret: config.linear.clientSecret,
    grant_type: "client_credentials",
    scope: getLinearScope(),
  });

  const response = await fetch("https://api.linear.app/oauth/token", {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch Linear client credentials token: ${response.status} ${text}`);
  }

  const json = await response.json();
  const accessToken =
    typeof json?.access_token === "string" ? json.access_token : null;
  const expiresIn =
    typeof json?.expires_in === "number" ? json.expires_in : 60 * 30;
  if (!accessToken) {
    throw new Error("Linear token response did not include access_token");
  }

  cachedToken = {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return accessToken;
}

export async function linearGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  parse: (input: unknown) => T,
): Promise<T> {
  const accessToken = await getLinearAccessToken();
  if (!accessToken) {
    throw new Error("Linear access token is not configured");
  }

  const response = await fetch("https://api.linear.app/graphql", {
    body: JSON.stringify({ query, variables }),
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

  const json = await response.json();
  if (!response.ok || (typeof json === "object" && json !== null && "errors" in json)) {
    throw new Error(`Linear GraphQL request failed: ${JSON.stringify(json)}`);
  }
  return parse(json);
}
