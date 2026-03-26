import { z } from "zod";
import type { WsServerMessage, WsControlMessage } from "./ws.js";

// ---------------------------------------------------------------------------
// Server → Client message schemas
// ---------------------------------------------------------------------------

const WsEventMessageSchema = z.object({
  type: z.literal("event"),
  timestamp: z.string(),
  event: z.object({
    type: z.string(),
    data: z.record(z.string(), z.unknown()),
    timestamp: z.string(),
  }),
});

const WsConnectedMessageSchema = z.object({
  type: z.literal("connected"),
  sessionId: z.string(),
});

const WsErrorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export const WsServerMessageSchema = z.union([
  WsEventMessageSchema,
  WsConnectedMessageSchema,
  WsErrorMessageSchema,
]) satisfies z.ZodType<WsServerMessage>;

// ---------------------------------------------------------------------------
// Client → Server message schemas
// ---------------------------------------------------------------------------

const WsPromptActionSchema = z.object({
  action: z.literal("prompt"),
  text: z.string(),
});

const WsPermissionRespondActionSchema = z.object({
  action: z.literal("permission.respond"),
  requestId: z.string(),
  body: z.union([
    z.object({ optionId: z.string() }),
    z.object({ outcome: z.literal("cancelled") }),
  ]),
});

const WsCancelActionSchema = z.object({
  action: z.literal("cancel"),
  queueId: z.string().optional(),
});

const WsTerminateActionSchema = z.object({
  action: z.literal("terminate"),
});

const WsPingActionSchema = z.object({
  action: z.literal("ping"),
});

const WsQueueReorderActionSchema = z.object({
  action: z.literal("queue.reorder"),
  order: z.array(z.string()),
});

const WsQueueClearActionSchema = z.object({
  action: z.literal("queue.clear"),
});

const WsQueuePauseActionSchema = z.object({
  action: z.literal("queue.pause"),
});

const WsQueueResumeActionSchema = z.object({
  action: z.literal("queue.resume"),
});

export const WsControlMessageSchema = z.union([
  WsPromptActionSchema,
  WsPermissionRespondActionSchema,
  WsCancelActionSchema,
  WsTerminateActionSchema,
  WsPingActionSchema,
  WsQueueReorderActionSchema,
  WsQueueClearActionSchema,
  WsQueuePauseActionSchema,
  WsQueueResumeActionSchema,
]) satisfies z.ZodType<WsControlMessage>;
