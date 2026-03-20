import { z } from "zod";

export const ChatProviderSchema = z.enum(["slack"]);
export type ChatProvider = z.infer<typeof ChatProviderSchema>;

export const ChatInboundEventSchema = z.object({
  authorId: z.string().min(1),
  authorName: z.string().min(1),
  channelId: z.string().min(1),
  isDM: z.boolean(),
  messageId: z.string().min(1),
  occurredAt: z.string().min(1),
  provider: ChatProviderSchema,
  providerMeta: z.record(z.string(), z.unknown()).optional(),
  text: z.string(),
  threadId: z.string().min(1),
});
export type ChatInboundEvent = z.infer<typeof ChatInboundEventSchema>;

export const ChatDispatchContextSchema = ChatInboundEventSchema.pick({
  authorId: true,
  channelId: true,
  isDM: true,
  messageId: true,
  provider: true,
  threadId: true,
});
export type ChatDispatchContext = z.infer<typeof ChatDispatchContextSchema>;

export const QueuedExternalEventSchema = z.discriminatedUnion("type", [
  z.object({
    event: ChatInboundEventSchema,
    type: z.literal("chat_inbound"),
  }),
]);
export type QueuedExternalEvent = z.infer<typeof QueuedExternalEventSchema>;

export const ReplySourceChatActionSchema = z.object({
  text: z.string().min(1),
  type: z.literal("reply_source"),
});

export const PostThreadChatActionSchema = z.object({
  text: z.string().min(1),
  threadId: z.string().min(1),
  type: z.literal("post_thread"),
});

export const PostChannelChatActionSchema = z.object({
  channelId: z.string().min(1),
  text: z.string().min(1),
  type: z.literal("post_channel"),
});

export const StartThreadChatActionSchema = z.object({
  channelId: z.string().min(1),
  text: z.string().min(1),
  type: z.literal("start_thread"),
});

export const DmUserChatActionSchema = z.object({
  text: z.string().min(1),
  type: z.literal("dm_user"),
  userId: z.string().min(1),
});

export const ReactChatActionSchema = z.object({
  emoji: z.string().min(1),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  type: z.literal("react"),
});

export const ChatActionRequestSchema = z.discriminatedUnion("type", [
  ReplySourceChatActionSchema,
  PostThreadChatActionSchema,
  PostChannelChatActionSchema,
  StartThreadChatActionSchema,
  DmUserChatActionSchema,
  ReactChatActionSchema,
]);
export type ChatActionRequest = z.infer<typeof ChatActionRequestSchema>;

export const ChatActionResultSchema = z.object({
  channelId: z.string().nullable(),
  messageId: z.string().nullable(),
  provider: ChatProviderSchema,
  threadId: z.string().nullable(),
});
export type ChatActionResult = z.infer<typeof ChatActionResultSchema>;
