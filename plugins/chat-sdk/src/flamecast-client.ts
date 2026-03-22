import type { McpServerHttp } from "@agentclientprotocol/sdk";
import { z } from "zod";

const FlamecastAgentSchema = z.object({
  id: z.string(),
});

const FlamecastPromptResultSchema = z.object({
  stopReason: z.string(),
});

const FlamecastErrorSchema = z.object({
  error: z.string(),
});

export type FlamecastSpawn = {
  command: string;
  args?: string[];
};

export type FlamecastCreateAgentBody = {
  cwd?: string;
  agentTemplateId?: string;
  spawn?: FlamecastSpawn;
  name?: string;
  mcpServers?: Array<McpServerHttp & { type: "http" }>;
};

export type FlamecastAgent = z.infer<typeof FlamecastAgentSchema>;
export type FlamecastPromptResult = z.infer<typeof FlamecastPromptResultSchema>;
export type FlamecastAgentClient = Pick<
  FlamecastHttpClient,
  "createAgent" | "promptAgent" | "terminateAgent"
>;

type FlamecastHttpClientOptions = {
  baseUrl: string | URL;
  fetch?: typeof fetch;
};

type JsonSchema<T> = z.ZodType<T>;

export class FlamecastHttpClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FlamecastHttpClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createAgent(body: FlamecastCreateAgentBody): Promise<FlamecastAgent> {
    return this.requestJson(
      "/api/agents",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      FlamecastAgentSchema,
    );
  }

  async promptAgent(agentId: string, text: string): Promise<FlamecastPromptResult> {
    return this.requestJson(
      `/api/agents/${encodeURIComponent(agentId)}/prompt`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ text }),
      },
      FlamecastPromptResultSchema,
    );
  }

  async terminateAgent(agentId: string): Promise<void> {
    const response = await this.fetchImpl(
      new URL(`/api/agents/${encodeURIComponent(agentId)}`, this.baseUrl),
      {
        method: "DELETE",
      },
    );

    if (!response.ok) {
      throw new Error(await readError(response));
    }
  }

  private async requestJson<T>(
    pathname: string,
    init: RequestInit,
    schema: JsonSchema<T>,
  ): Promise<T> {
    const response = await this.fetchImpl(new URL(pathname, this.baseUrl), init);
    if (!response.ok) {
      throw new Error(await readError(response));
    }

    return schema.parse(await response.json());
  }
}

export function createConnectorMcpServer(
  endpoint: string | URL,
  authToken: string,
  options: { headerName?: string; serverName?: string } = {},
): McpServerHttp & { type: "http" } {
  return {
    type: "http",
    name: options.serverName ?? "chat-sdk",
    url: new URL(endpoint).toString(),
    headers: [
      {
        name: options.headerName ?? "x-flamecast-chat-token",
        value: authToken,
      },
    ],
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = FlamecastErrorSchema.parse(await response.json());
    return payload.error;
  } catch {
    return response.statusText || `Request failed with status ${response.status}`;
  }
}
