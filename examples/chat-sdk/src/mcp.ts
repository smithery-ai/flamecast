import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { ChatSdkThread, SqlThreadAgentBindingStore, ThreadAgentBinding } from "./bindings.js";
import type { FlamecastAgentClient } from "./flamecast.js";

type ChatToolsContext = {
  binding: ThreadAgentBinding;
  thread: ChatSdkThread;
  bindings: SqlThreadAgentBindingStore;
  flamecast: Pick<FlamecastAgentClient, "terminateAgent">;
  forgetThread: (threadId: string) => void;
};

export function createChatToolsServer(context: ChatToolsContext): McpServer {
  const server = new McpServer({
    name: "flamecast-chat-sdk",
    version: "0.0.0",
  });

  server.registerTool(
    "reply",
    {
      title: "Reply to chat",
      description:
        "Send a visible reply to the currently bound chat thread. If you intend to reply after more than trivial reasoning, call typing.start before thinking through the final response.",
      inputSchema: {
        text: z.string().min(1),
      },
    },
    async ({ text }) => {
      await context.thread.post(text);
      return {
        content: [{ type: "text", text: "Reply sent." }],
      };
    },
  );

  server.registerTool(
    "typing.start",
    {
      title: "Start typing",
      description:
        "Show a typing indicator in the currently bound thread before longer reasoning when you expect to send a reply.",
    },
    async () => {
      await context.thread.startTyping?.();
      return {
        content: [{ type: "text", text: "Typing indicator started." }],
      };
    },
  );

  server.registerTool(
    "subscribe",
    {
      title: "Subscribe to thread",
      description: "Keep listening to follow-up messages in the currently bound chat thread.",
    },
    async () => {
      await context.thread.subscribe?.();
      return {
        content: [{ type: "text", text: "Subscribed to thread." }],
      };
    },
  );

  server.registerTool(
    "unsubscribe",
    {
      title: "Unsubscribe from thread",
      description:
        "Stop listening to the currently bound chat thread and terminate the dedicated Flamecast agent for it.",
    },
    async () => {
      await context.thread.unsubscribe?.();
      await context.flamecast.terminateAgent(context.binding.agentId);
      await context.bindings.deleteByThreadId(context.binding.threadId);
      context.forgetThread(context.binding.threadId);
      return {
        content: [{ type: "text", text: "Unsubscribed from thread." }],
      };
    },
  );

  return server;
}

export async function handleChatMcpRequest(
  request: Request,
  context: ChatToolsContext,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createChatToolsServer(context);
  await server.connect(transport);
  return transport.handleRequest(request);
}
