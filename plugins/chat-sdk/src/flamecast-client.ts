import { z } from "zod";

const SessionLogSchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});

const FlamecastAgentSchema = z.object({
  id: z.string(),
  logs: z.array(SessionLogSchema).optional(),
});

const FlamecastPromptResultSchema = z.object({
  stopReason: z.string(),
});

const FlamecastPromptReplySchema = FlamecastPromptResultSchema.extend({
  replyText: z.string().nullable(),
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
};

export type FlamecastAgent = z.infer<typeof FlamecastAgentSchema>;
export type FlamecastPromptResult = z.infer<typeof FlamecastPromptResultSchema>;
export type FlamecastPromptReply = z.infer<typeof FlamecastPromptReplySchema>;
export type FlamecastAgentClient = Pick<
  FlamecastHttpClient,
  "createAgent" | "promptAgent" | "promptAgentForReply" | "terminateAgent"
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

  private async getAgent(agentId: string): Promise<FlamecastAgent> {
    return this.requestJson(
      `/api/agents/${encodeURIComponent(agentId)}`,
      {
        method: "GET",
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

  async promptAgentForReply(agentId: string, text: string): Promise<FlamecastPromptReply> {
    const before = await this.getAgent(agentId);
    const beforeLogCount = before.logs?.length ?? 0;
    const result = await this.promptAgent(agentId, text);
    const after = await this.getAgent(agentId);
    const replyText = extractReplyTextFromLogs(after.logs?.slice(beforeLogCount) ?? []);

    return FlamecastPromptReplySchema.parse({
      ...result,
      replyText,
    });
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

function extractReplyTextFromLogs(logs: Array<z.infer<typeof SessionLogSchema>>): string | null {
  const chunks: string[] = [];

  for (const log of logs) {
    if (log.type !== "rpc") {
      continue;
    }

    const method = log.data.method;
    const direction = log.data.direction;
    const phase = log.data.phase;
    const payload = log.data.payload;

    if (
      method !== "session/update" ||
      direction !== "agent_to_client" ||
      phase !== "notification" ||
      typeof payload !== "object" ||
      payload === null ||
      !("update" in payload) ||
      typeof payload.update !== "object" ||
      payload.update === null
    ) {
      continue;
    }

    const update = payload.update;
    if (
      !("sessionUpdate" in update) ||
      update.sessionUpdate !== "agent_message_chunk" ||
      !("content" in update) ||
      typeof update.content !== "object" ||
      update.content === null
    ) {
      continue;
    }

    const content = update.content;
    if (
      "type" in content &&
      content.type === "text" &&
      "text" in content &&
      typeof content.text === "string"
    ) {
      chunks.push(content.text);
    }
  }

  const replyText = chunks.join("").trim();
  return replyText || null;
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = FlamecastErrorSchema.parse(await response.json());
    return payload.error;
  } catch {
    return response.statusText || `Request failed with status ${response.status}`;
  }
}
