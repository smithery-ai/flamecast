/**
 * Chat SDK bot: handles Slack events and calls the Flamecast REST client.
 *
 * Two responsibilities:
 *   1. onNewMention       — creates a Flamecast session, sends the mention text as first prompt
 *   2. onSubscribedMessage — forwards follow-up messages as additional prompts
 */
import { Chat, type Thread } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { createFlamecastClient } from "@flamecast/sdk/client";

type FlamecastClient = ReturnType<typeof createFlamecastClient>;

interface ThreadState {
  sessionId: string;
}

/** Reverse lookup: sessionId -> Thread (used by webhook handler to post to Slack) */
export const sessionThreads = new Map<string, Thread>();

export function createBot(client: FlamecastClient) {
  const bot = new Chat({
    userName: "flamecast-agent",
    adapters: {
      slack: createSlackAdapter({
        botToken: process.env.SLACK_BOT_TOKEN!,
        signingSecret: process.env.SLACK_SIGNING_SECRET!,
      }),
    },
    state: createMemoryState(),
  });

  // --- New mention: create session + send first prompt ---

  bot.onNewMention(async (thread, message) => {
    await thread.subscribe();

    const session = await client.createSession({
      agentTemplateId: process.env.AGENT_TEMPLATE_ID || "example",
    });

    await thread.setState({ sessionId: session.id } satisfies ThreadState);
    sessionThreads.set(session.id, thread);

    await client.promptSession(session.id, message.text);
    await thread.post("_Working on it..._");
  });

  // --- Subscribed message: forward as additional prompt ---

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;

    const state = (await thread.state) as ThreadState | null;
    if (!state?.sessionId) return;

    await client.promptSession(state.sessionId, message.text);
  });

  return bot;
}
