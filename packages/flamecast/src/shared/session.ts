import { z } from "zod";
import type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  FileSystemSnapshot,
  PendingPermission,
  PendingPermissionOption,
  PromptQueueState,
  RegisterAgentTemplateBody,
  Session,
  SessionLog,
} from "@flamecast/protocol/session";
// Some types above are only used by zod `satisfies` constraints, not re-exported
import type { FileSystemEntry } from "@flamecast/protocol/session-host";

// ---------------------------------------------------------------------------
// Re-export all types from protocol (single source of truth)
// ---------------------------------------------------------------------------

export type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  PendingPermission,
  PermissionResponseBody,
  RegisterAgentTemplateBody,
  Session,
  SessionLog,
} from "@flamecast/protocol/session";
export type { FileSystemEntry } from "@flamecast/protocol/session-host";
// CreateSessionBody re-exported below (after the refined schema definition)

// ---------------------------------------------------------------------------
// Zod schemas for API boundary validation
//
// These schemas validate user input at API endpoints. The `satisfies`
// constraint ensures they stay in sync with the protocol interfaces —
// if the protocol type changes and the schema doesn't match, tsc fails.
// ---------------------------------------------------------------------------

const AgentSpawnSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
}) satisfies z.ZodType<AgentSpawn>;

const AgentTemplateRuntimeSchema = z.object({
  provider: z.string().min(1),
  image: z.string().optional(),
  dockerfile: z.string().optional(),
  setup: z.string().optional(),
}) satisfies z.ZodType<AgentTemplateRuntime>;

export const AgentTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  spawn: AgentSpawnSchema,
  runtime: AgentTemplateRuntimeSchema,
}) satisfies z.ZodType<AgentTemplate>;

export const RegisterAgentTemplateBodySchema = z.object({
  name: z.string().min(1),
  spawn: AgentSpawnSchema,
  runtime: AgentTemplateRuntimeSchema.optional(),
}) satisfies z.ZodType<RegisterAgentTemplateBody>;

/**
 * Create a RegisterAgentTemplateBodySchema with runtime.provider constrained
 * to a known set of runtime names. Use at the API boundary for runtime validation.
 */
export function createRegisterAgentTemplateBodySchema(runtimeNames: [string, ...string[]]) {
  return z.object({
    name: z.string().min(1),
    spawn: AgentSpawnSchema,
    runtime: z
      .object({
        provider: z.enum(runtimeNames),
        image: z.string().optional(),
        dockerfile: z.string().optional(),
        setup: z.string().optional(),
      })
      .optional(),
  });
}

const SessionLogSchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<SessionLog>;

const PendingPermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.string(),
}) satisfies z.ZodType<PendingPermissionOption>;

const PendingPermissionSchema = z.object({
  requestId: z.string(),
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  options: z.array(PendingPermissionOptionSchema),
}) satisfies z.ZodType<PendingPermission>;

const FileSystemEntrySchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory", "symlink", "other"]),
}) satisfies z.ZodType<FileSystemEntry>;

const FileSystemSnapshotSchema = z.object({
  root: z.string(),
  entries: z.array(FileSystemEntrySchema),
  truncated: z.boolean(),
  maxEntries: z.number().int().nonnegative(),
}) satisfies z.ZodType<FileSystemSnapshot>;

const PromptQueueItemSchema = z.object({
  queueId: z.string(),
  text: z.string(),
  enqueuedAt: z.string(),
  position: z.number().int().nonnegative(),
});

const PromptQueueStateSchema = z.object({
  processing: z.boolean(),
  items: z.array(PromptQueueItemSchema),
  size: z.number().int().nonnegative(),
}) satisfies z.ZodType<PromptQueueState>;

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
  websocketUrl: z.string().optional(),
}) satisfies z.ZodType<Session>;

export type { CreateSessionBody } from "@flamecast/protocol/session";

export const CreateSessionBodySchema = z
  .object({
    cwd: z.string().optional(),
    agentTemplateId: z.string().optional(),
    spawn: AgentSpawnSchema.optional(),
    name: z.string().optional(),
  })
  .refine((b) => Boolean(b.agentTemplateId) !== Boolean(b.spawn), {
    message: "Provide exactly one of agentTemplateId or spawn",
  });

// Compile-time check: ensure the schema's output type stays compatible with
// the protocol's CreateSessionBody. Cannot use `satisfies` because .refine()
// changes the schema type, but this assignment fails if they drift.
import type { CreateSessionBody as _CreateSessionBodyCheck } from "@flamecast/protocol/session";
type _SchemaOutput = z.output<typeof CreateSessionBodySchema>;
type _Drift = _SchemaOutput extends _CreateSessionBodyCheck ? true : never;
const _driftCheck: _Drift = true;
void _driftCheck;
