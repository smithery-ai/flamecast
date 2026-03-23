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

export const WsFilePreviewResponseSchema = z.object({
  type: z.literal("file.preview"),
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  maxChars: z.number(),
});

export const WsFsSnapshotResponseSchema = z.object({
  type: z.literal("fs.snapshot"),
  root: z.string(),
  entries: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["file", "directory", "symlink", "other"]),
    }),
  ),
  truncated: z.boolean(),
  maxEntries: z.number(),
});

export type WsServerMessage =
  | z.infer<typeof WsEventMessageSchema>
  | z.infer<typeof WsConnectedMessageSchema>
  | z.infer<typeof WsErrorMessageSchema>
  | z.infer<typeof WsFilePreviewResponseSchema>
  | z.infer<typeof WsFsSnapshotResponseSchema>;

// ---- Client → Server messages ----

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

const WsFilePreviewActionSchema = z.object({
  action: z.literal("file.preview"),
  path: z.string(),
});

const WsFsSnapshotActionSchema = z.object({
  action: z.literal("fs.snapshot"),
  showAllFiles: z.boolean().optional(),
});

export const WsControlMessageSchema = z.union([
  WsPromptActionSchema,
  WsPermissionRespondActionSchema,
  WsCancelActionSchema,
  WsTerminateActionSchema,
  WsPingActionSchema,
  WsFilePreviewActionSchema,
  WsFsSnapshotActionSchema,
]);

export type WsControlMessage = z.infer<typeof WsControlMessageSchema>;
