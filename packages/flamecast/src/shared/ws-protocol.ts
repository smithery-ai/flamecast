import { z } from "zod";

// ---- Server → Client messages ----

export const WsEventMessageSchema = z.object({
  type: z.literal("event"),
  timestamp: z.string(),
  event: z.object({
    type: z.string(),
    data: z.record(z.string(), z.unknown()),
    timestamp: z.string(),
  }),
});

export const WsConnectedMessageSchema = z.object({
  type: z.literal("connected"),
  sessionId: z.string(),
});

export const WsErrorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export type WsServerMessage =
  | z.infer<typeof WsEventMessageSchema>
  | z.infer<typeof WsConnectedMessageSchema>
  | z.infer<typeof WsErrorMessageSchema>;

// ---- Client → Server messages ----

export const WsPromptActionSchema = z.object({
  action: z.literal("prompt"),
  text: z.string(),
});

export const WsPermissionRespondActionSchema = z.object({
  action: z.literal("permission.respond"),
  requestId: z.string(),
  body: z.union([
    z.object({ optionId: z.string() }),
    z.object({ outcome: z.literal("cancelled") }),
  ]),
});

export const WsCancelActionSchema = z.object({
  action: z.literal("cancel"),
  queueId: z.string().optional(),
});

export const WsTerminateActionSchema = z.object({
  action: z.literal("terminate"),
});

export const WsPingActionSchema = z.object({
  action: z.literal("ping"),
});

export const WsControlMessageSchema = z.union([
  WsPromptActionSchema,
  WsPermissionRespondActionSchema,
  WsCancelActionSchema,
  WsTerminateActionSchema,
  WsPingActionSchema,
]);

export type WsControlMessage = z.infer<typeof WsControlMessageSchema>;
