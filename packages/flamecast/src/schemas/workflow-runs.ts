import { z } from "zod"

// --- Shared error schema ---

export const WorkflowRunErrorSchema = z
	.object({
		error: z.string().meta({ example: "Unauthorized" }),
	})
	.meta({ id: "WorkflowRunError" })

// --- POST /workflow-runs/ ---

export const CreateWorkflowRunRequestSchema = z
	.object({
		workflowRunId: z
			.number()
			.int()
			.meta({ description: "GitHub Actions workflow run ID" }),
		repo: z.string().optional().meta({
			description: "Target repository (owner/name)",
			example: "smithery-ai/example",
		}),
		sourceRepo: z.string().optional().meta({
			description: "Source repository (owner/name)",
			example: "smithery-ai/source",
		}),
		prompt: z
			.string()
			.optional()
			.meta({ description: "User prompt that triggered the workflow" }),
	})
	.meta({ id: "CreateWorkflowRunRequest" })

export const CreateWorkflowRunResponseSchema = z
	.object({
		success: z.literal(true),
		id: z
			.string()
			.uuid()
			.meta({ description: "Database UUID of the created workflow run" }),
	})
	.meta({ id: "CreateWorkflowRunResponse" })

// --- PATCH /workflow-runs/:id ---

export const WorkflowRunIdParamSchema = z.object({
	id: z.string().uuid().meta({ description: "Workflow run UUID" }),
})

export const PatchWorkflowRunResponseSchema = z
	.object({
		success: z.literal(true),
		status: z
			.enum(["completed", "error", "pending"])
			.optional()
			.meta({ description: "Inferred status from GitHub Actions" }),
		alreadyResolved: z.boolean().optional().meta({
			description: "True if the run was already completed or errored",
		}),
	})
	.meta({ id: "PatchWorkflowRunResponse" })

// --- GET /workflow-runs/ ---

export const ListWorkflowRunsQuerySchema = z
	.object({
		repo: z
			.string()
			.optional()
			.meta({ description: "Filter by target repository" }),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.meta({ description: "Max results per page (default 5, max 100)" }),
		cursor: z
			.string()
			.optional()
			.meta({ description: "Cursor for pagination (ISO 8601 timestamp)" }),
		includeArchived: z
			.enum(["true", "false"])
			.optional()
			.meta({ description: "Include archived runs (default false)" }),
	})
	.meta({ id: "ListWorkflowRunsQuery" })

export const WorkflowRunItemSchema = z
	.object({
		id: z.string().uuid(),
		workflowRunId: z.number().int(),
		userId: z.string(),
		repo: z.string().nullable(),
		sourceRepo: z.string().nullable(),
		prompt: z.string().nullable(),
		prUrl: z.string().nullable(),
		errorMessage: z.string().nullable(),
		startedAt: z
			.string()
			.nullable()
			.meta({ description: "ISO 8601 timestamp" }),
		completedAt: z
			.string()
			.nullable()
			.meta({ description: "ISO 8601 timestamp" }),
		errorAt: z.string().nullable().meta({ description: "ISO 8601 timestamp" }),
		archivedAt: z
			.string()
			.nullable()
			.meta({ description: "ISO 8601 timestamp" }),
		createdAt: z.string().meta({ description: "ISO 8601 timestamp" }),
	})
	.meta({ id: "WorkflowRunItem" })

export const ListWorkflowRunsResponseSchema = z
	.object({
		runs: z.array(WorkflowRunItemSchema),
		hasMore: z
			.boolean()
			.meta({ description: "Whether there are more results" }),
		nextCursor: z
			.string()
			.nullable()
			.meta({ description: "Cursor for next page" }),
	})
	.meta({ id: "ListWorkflowRunsResponse" })

// All schemas with .meta({ id }) for OpenAPI injection
export const allSchemas = [
	WorkflowRunErrorSchema,
	CreateWorkflowRunRequestSchema,
	CreateWorkflowRunResponseSchema,
	PatchWorkflowRunResponseSchema,
	ListWorkflowRunsQuerySchema,
	WorkflowRunItemSchema,
	ListWorkflowRunsResponseSchema,
]
