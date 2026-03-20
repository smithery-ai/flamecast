import { z } from "zod";

/** How the server spawns an ACP agent child process (maps to `child_process.spawn`). */
export const AgentSpawnSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});
export type AgentSpawn = z.infer<typeof AgentSpawnSchema>;

export const AgentProcessInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  spawn: AgentSpawnSchema,
});
export type AgentProcessInfo = z.infer<typeof AgentProcessInfoSchema>;

export const RegisterAgentProcessBodySchema = z.object({
  label: z.string().min(1),
  spawn: AgentSpawnSchema,
});
export type RegisterAgentProcessBody = z.infer<typeof RegisterAgentProcessBodySchema>;

export const ConnectionLogSchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type ConnectionLog = z.infer<typeof ConnectionLogSchema>;

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

export const ConnectionInfoSchema = z.object({
  id: z.string(),
  agentLabel: z.string(),
  spawn: AgentSpawnSchema,
  sessionId: z.string(),
  startedAt: z.string(),
  lastUpdatedAt: z.string(),
  logs: z.array(ConnectionLogSchema),
  pendingPermission: PendingPermissionSchema.nullable(),
});
export type ConnectionInfo = z.infer<typeof ConnectionInfoSchema>;

export const CreateConnectionBodySchema = z
  .object({
    cwd: z.string().optional(),
    runtimeKind: z.enum(["local", "docker"]).default("local"),
    /** Use a process definition from `GET /agent-processes`. */
    agentProcessId: z.string().optional(),
    /** Spawn a one-off process without registering it. */
    spawn: AgentSpawnSchema.optional(),
    /** Display label when using `spawn` (defaults to `command` + `args`). */
    label: z.string().optional(),
  })
  .refine((b) => Boolean(b.agentProcessId) !== Boolean(b.spawn), {
    message: "Provide exactly one of agentProcessId or spawn",
  });
export type CreateConnectionBody = z.infer<typeof CreateConnectionBodySchema>;

export const PromptBodySchema = z.object({
  text: z.string(),
});
export type PromptBody = z.infer<typeof PromptBodySchema>;

export const PermissionResponseBodySchema = z.union([
  z.object({ optionId: z.string() }),
  z.object({ outcome: z.literal("cancelled") }),
]);
export type PermissionResponseBody = z.infer<typeof PermissionResponseBodySchema>;
