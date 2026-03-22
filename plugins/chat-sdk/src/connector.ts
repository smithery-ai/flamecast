import type { AppType } from "@acp/flamecast/api";
import type { CreateSessionBody, Session, SessionLog } from "@acp/flamecast/shared/session";
import type { Chat, Message, Thread } from "chat";
import { Hono } from "hono";
import { hc } from "hono/client";

type FlamecastClient = ReturnType<typeof hc<AppType>>;

export type ChatSdkConnectorOptions = {
  agent: CreateSessionBody;
  chat: Chat;
  flamecast: FlamecastClient;
};

export class ChatSdkConnector {
  private readonly agent: CreateSessionBody;
  private readonly app = new Hono();
  private readonly bindings = new Map<string, { agentId: string; thread: Thread }>();
  private readonly chat: Chat;
  private readonly flamecast: FlamecastClient;
  private handlersInstalled = false;
  private active = false;

  readonly fetch: (request: Request) => Promise<Response>;

  constructor(options: ChatSdkConnectorOptions) {
    this.agent = options.agent;
    this.chat = options.chat;
    this.flamecast = options.flamecast;
    this.fetch = async (request: Request) => this.app.fetch(request);

    this.app.get("/health", (c) =>
      c.json({
        status: "ok",
        bindings: this.bindings.size,
      }),
    );
    this.app.post("/webhooks/:platform", async (c) =>
      this.handleWebhookRequest(c.req.param("platform"), c.req.raw),
    );
  }

  start(): void {
    this.active = true;
    if (this.handlersInstalled) {
      return;
    }

    this.chat.onNewMention((thread, message) => this.handleInboundMessage(thread, message));
    this.chat.onSubscribedMessage((thread, message) => this.handleInboundMessage(thread, message));
    this.handlersInstalled = true;
  }

  async stop(): Promise<void> {
    this.active = false;
    const bindings = [...this.bindings.values()];
    await Promise.all(
      bindings.map(async (binding) => {
        await this.flamecast.agents[":agentId"]
          .$delete({
            param: { agentId: binding.agentId },
          })
          .catch(() => undefined);
      }),
    );
    this.bindings.clear();
  }

  async handleWebhookRequest(platform: string, request: Request): Promise<Response> {
    const handler = this.chat.webhooks[platform];
    if (!handler) {
      return new Response(JSON.stringify({ error: "Unknown webhook platform" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    return handler(request, {
      waitUntil(task) {
        void task.catch(() => undefined);
      },
    });
  }

  private async handleInboundMessage(thread: Thread, message: Message): Promise<void> {
    if (!this.active) {
      return;
    }

    const text = extractMessageText(message);
    if (!text) {
      return;
    }

    let binding = this.bindings.get(thread.id);
    if (!binding) {
      await thread.subscribe();
      const createAgentResponse = await this.flamecast.agents.$post({
        json: this.agent,
      });
      if (createAgentResponse.status !== 201) {
        throw new Error(await readError(createAgentResponse));
      }

      const agent = await createAgentResponse.json();
      binding = {
        agentId: agent.id,
        thread,
      };
      this.bindings.set(thread.id, binding);
    } else if (binding.thread !== thread) {
      binding = {
        ...binding,
        thread,
      };
      this.bindings.set(thread.id, binding);
    }

    const beforeResponse = await this.flamecast.agents[":agentId"].$get({
      param: { agentId: binding.agentId },
    });
    if (beforeResponse.status !== 200) {
      throw new Error(await readError(beforeResponse));
    }

    const before = await beforeResponse.json();
    const beforeLogCount = getSessionLogs(before).length;

    const promptResponse = await this.flamecast.agents[":agentId"].prompt.$post({
      param: { agentId: binding.agentId },
      json: { text },
    });
    if (promptResponse.status !== 200) {
      throw new Error(await readError(promptResponse));
    }

    await promptResponse.json();
    const afterResponse = await this.flamecast.agents[":agentId"].$get({
      param: { agentId: binding.agentId },
    });
    if (afterResponse.status !== 200) {
      throw new Error(await readError(afterResponse));
    }

    const after = await afterResponse.json();
    const replyText = extractReplyTextFromLogs(
      getSessionLogs(after).slice(beforeLogCount),
    )?.trim();

    if (replyText) {
      await thread.post(replyText);
    }
  }
}

export function extractMessageText(message: Message): string | null {
  const text = message.text.trim();
  return text || null;
}

function getSessionLogs(session: Session): SessionLog[] {
  return Array.isArray(session.logs) ? session.logs : [];
}

function extractReplyTextFromLogs(logs: SessionLog[]): string | null {
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
    const payload = await response.json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
    ) {
      return payload.error;
    }
  } catch {
    // Fall back to the HTTP status message when the body is not JSON.
  }

  return response.statusText || `Request failed with status ${response.status}`;
}
