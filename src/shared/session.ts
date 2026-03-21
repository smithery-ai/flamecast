import { z } from "zod";

/** How the server spawns an ACP agent child process (maps to `child_process.spawn`). */
export const AgentSpawnSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});
export type AgentSpawn = z.infer<typeof AgentSpawnSchema>;

export const RuntimeConfigSchema = z.object({
  provider: z.string().min(1),
  image: z.string().optional(),
  dockerfile: z.string().optional(),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

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

export const AgentSchema = z.object({
  id: z.string(),
  agentName: z.string(),
  spawn: AgentSpawnSchema,
  runtime: RuntimeConfigSchema,
  startedAt: z.string(),
  lastUpdatedAt: z.string(),
  latestSessionId: z.string().nullable(),
  sessionCount: z.number().int().nonnegative(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  spawn: AgentSpawnSchema,
  cwd: z.string(),
  startedAt: z.string(),
  lastUpdatedAt: z.string(),
  logs: z.array(SessionLogSchema),
  pendingPermission: PendingPermissionSchema.nullable(),
  fileSystem: FileSystemSnapshotSchema.nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

export const SessionSummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  cwd: z.string(),
  startedAt: z.string(),
  lastUpdatedAt: z.string(),
  pendingPermission: PendingPermissionSchema.nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const CreateAgentBodySchema = z.object({
  spawn: AgentSpawnSchema,
  runtime: RuntimeConfigSchema.optional(),
  name: z.string().optional(),
  initialSessionCwd: z.string().optional(),
});
export type CreateAgentBody = z.infer<typeof CreateAgentBodySchema>;

export const PermissionResponseBodySchema = z.union([
  z.object({ optionId: z.string() }),
  z.object({ outcome: z.literal("cancelled") }),
]);
export type PermissionResponseBody = z.infer<typeof PermissionResponseBodySchema>;
