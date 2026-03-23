import { z } from "zod";

/** How the server spawns an ACP agent child process (maps to `child_process.spawn`). */
export const AgentSpawnSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});
export type AgentSpawn = z.infer<typeof AgentSpawnSchema>;

export const AgentTemplateRuntimeSchema = z.object({
  provider: z.string().min(1),
  image: z.string().optional(),
  dockerfile: z.string().optional(),
});
export type AgentTemplateRuntime = z.infer<typeof AgentTemplateRuntimeSchema>;

export const AgentTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  spawn: AgentSpawnSchema,
  runtime: AgentTemplateRuntimeSchema,
});
export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;

export const RegisterAgentTemplateBodySchema = z.object({
  name: z.string().min(1),
  spawn: AgentSpawnSchema,
  runtime: AgentTemplateRuntimeSchema.optional(),
});
export type RegisterAgentTemplateBody = z.infer<typeof RegisterAgentTemplateBodySchema>;

export const SessionLogSchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type SessionLog = z.infer<typeof SessionLogSchema>;

export const PendingPermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.string(),
});
export type PendingPermissionOption = z.infer<typeof PendingPermissionOptionSchema>;

export const PendingPermissionSchema = z.object({
  requestId: z.string(),
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  options: z.array(PendingPermissionOptionSchema),
});
export type PendingPermission = z.infer<typeof PendingPermissionSchema>;

export const FileSystemEntrySchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory", "symlink", "other"]),
});
export type FileSystemEntry = z.infer<typeof FileSystemEntrySchema>;

export const FileSystemSnapshotSchema = z.object({
  root: z.string(),
  entries: z.array(FileSystemEntrySchema),
  truncated: z.boolean(),
  maxEntries: z.number().int().nonnegative(),
});
export type FileSystemSnapshot = z.infer<typeof FileSystemSnapshotSchema>;

export const FilePreviewSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  maxChars: z.number().int().positive(),
});
export type FilePreview = z.infer<typeof FilePreviewSchema>;

export const QueuedPromptResponseSchema = z.object({
  queued: z.literal(true),
  queueId: z.string(),
  position: z.number().int().positive(),
});
export type QueuedPromptResponse = z.infer<typeof QueuedPromptResponseSchema>;

export const PromptQueueItemSchema = z.object({
  queueId: z.string(),
  text: z.string(),
  enqueuedAt: z.string(),
  position: z.number().int().nonnegative(),
});

export const PromptQueueStateSchema = z.object({
  processing: z.boolean(),
  items: z.array(PromptQueueItemSchema),
  size: z.number().int().nonnegative(),
});
export type PromptQueueState = z.infer<typeof PromptQueueStateSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  agentName: z.string(),
  spawn: AgentSpawnSchema,
  startedAt: z.string(),
  lastUpdatedAt: z.string(),
  status: z.enum(["active", "killed"]),
  logs: z.array(SessionLogSchema),
  pendingPermission: PendingPermissionSchema.nullable(),
  fileSystem: FileSystemSnapshotSchema.nullable(),
  promptQueue: PromptQueueStateSchema.nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

export const CreateSessionBodySchema = z
  .object({
    cwd: z.string().optional(),
    /** Use a reusable template definition from `GET /agent-templates`. */
    agentTemplateId: z.string().optional(),
    /** Spawn a one-off process without registering it. */
    spawn: AgentSpawnSchema.optional(),
    /** Display name when using `spawn` (defaults to `command` + `args`). */
    name: z.string().optional(),
  })
  .refine((b) => Boolean(b.agentTemplateId) !== Boolean(b.spawn), {
    message: "Provide exactly one of agentTemplateId or spawn",
  });
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

export const PromptBodySchema = z.object({
  text: z.string(),
});
export type PromptBody = z.infer<typeof PromptBodySchema>;

export const PromptResultSchema = z.object({
  stopReason: z.string(),
});
export type PromptResult = z.infer<typeof PromptResultSchema>;

export const PermissionResponseBodySchema = z.union([
  z.object({ optionId: z.string() }),
  z.object({ outcome: z.literal("cancelled") }),
]);
export type PermissionResponseBody = z.infer<typeof PermissionResponseBodySchema>;

export const SESSION_EVENT_TYPES = {
  FILESYSTEM_SNAPSHOT: "filesystem.snapshot",
  SESSION_TERMINATED: "session.terminated",
} as const;
