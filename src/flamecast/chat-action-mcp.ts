import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import type { ChatActionRequest, ChatActionResult } from "../shared/chat.js";
import { ChatActionResultSchema } from "../shared/chat.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const baseUrl = requiredEnv("FLAMECAST_INTERNAL_API_BASE_URL").replace(/\/$/, "");
const token = requiredEnv("FLAMECAST_INTERNAL_API_TOKEN");
const connectionId = requiredEnv("FLAMECAST_CONNECTION_ID");

async function callChatAction(action: ChatActionRequest): Promise<ChatActionResult> {
  const response = await fetch(
    `${baseUrl}/connections/${encodeURIComponent(connectionId)}/chat/actions`,
    {
      body: JSON.stringify(action),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    let message = `Chat action failed with status ${response.status}`;
    try {
      const body = await response.json();
      if (
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string" &&
        body.error.trim()
      ) {
        message = body.error;
      }
    } catch {
      // Ignore malformed error bodies and fall back to the HTTP status.
    }

    throw new Error(message);
  }

  const json = await response.json();
  return ChatActionResultSchema.parse(json);
}

function textResult(result: ChatActionResult) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

const server = new McpServer({
  name: "flamecast-chat-actions",
  version: "1.0.0",
});

server.registerTool(
  "reply_source",
  {
    description:
      "Reply to the most recent inbound chat event for the current Flamecast connection.",
    inputSchema: {
      text: z.string().min(1),
    },
  },
  async ({ text }) => textResult(await callChatAction({ text, type: "reply_source" })),
);

server.registerTool(
  "post_thread",
  {
    description: "Post a visible message into an existing chat thread.",
    inputSchema: {
      text: z.string().min(1),
      threadId: z.string().min(1),
    },
  },
  async ({ text, threadId }) =>
    textResult(await callChatAction({ text, threadId, type: "post_thread" })),
);

server.registerTool(
  "post_channel",
  {
    description: "Post a top-level message to a chat channel.",
    inputSchema: {
      channelId: z.string().min(1),
      text: z.string().min(1),
    },
  },
  async ({ channelId, text }) =>
    textResult(await callChatAction({ channelId, text, type: "post_channel" })),
);

server.registerTool(
  "start_thread",
  {
    description: "Start a new thread by posting a new top-level message to a chat channel.",
    inputSchema: {
      channelId: z.string().min(1),
      text: z.string().min(1),
    },
  },
  async ({ channelId, text }) =>
    textResult(await callChatAction({ channelId, text, type: "start_thread" })),
);

server.registerTool(
  "dm_user",
  {
    description: "Send a direct message to a user.",
    inputSchema: {
      text: z.string().min(1),
      userId: z.string().min(1),
    },
  },
  async ({ text, userId }) => textResult(await callChatAction({ text, type: "dm_user", userId })),
);

server.registerTool(
  "react",
  {
    description: "Add a reaction to a specific chat message.",
    inputSchema: {
      emoji: z.string().min(1),
      messageId: z.string().min(1),
      threadId: z.string().min(1),
    },
  },
  async ({ emoji, messageId, threadId }) =>
    textResult(await callChatAction({ emoji, messageId, threadId, type: "react" })),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Flamecast chat action MCP server failed:", error);
  process.exit(1);
});
