import { z } from "zod"
import { WorkflowRunItemSchema } from "./workflow-runs.js"

// --- POST /chats ---

export const CreateChatRequestSchema = z
	.object({
		title: z.string().min(1).max(200).meta({ description: "Chat title" }),
		repo: z
			.string()
			.optional()
			.meta({ description: "Target repository (owner/name)" }),
		sourceRepoId: z
			.string()
			.uuid()
			.optional()
			.meta({ description: "Source repository UUID" }),
	})
	.meta({ id: "CreateChatRequest" })

export const CreateChatResponseSchema = z
	.object({
		success: z.literal(true),
		id: z
			.string()
			.uuid()
			.meta({ description: "Database UUID of the created chat" }),
	})
	.meta({ id: "CreateChatResponse" })

// --- PATCH /chats/:id ---

export const ChatIdParamSchema = z.object({
	id: z.string().uuid().meta({ description: "Chat UUID" }),
})

export const UpdateChatRequestSchema = z
	.object({
		title: z
			.string()
			.min(1)
			.max(200)
			.optional()
			.meta({ description: "New chat title" }),
	})
	.meta({ id: "UpdateChatRequest" })

// --- GET /chats ---

export const ChatItemSchema = z
	.object({
		id: z.string().uuid(),
		userId: z.string(),
		title: z.string(),
		repo: z.string().nullable(),
		sourceRepoId: z.string().uuid().nullable(),
		archivedAt: z
			.string()
			.nullable()
			.meta({ description: "ISO 8601 timestamp" }),
		createdAt: z.string().meta({ description: "ISO 8601 timestamp" }),
		updatedAt: z.string().meta({ description: "ISO 8601 timestamp" }),
		lastPrompt: z.string().nullable().optional(),
		runCount: z.number().int().optional(),
		latestRunStatus: z
			.enum(["running", "completed", "error", "queued"])
			.nullable()
			.optional(),
	})
	.meta({ id: "ChatItem" })

export const ListChatsQuerySchema = z
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
			.meta({ description: "Max results per page (default 10, max 100)" }),
		cursor: z
			.string()
			.optional()
			.meta({ description: "Cursor for pagination (ISO 8601 timestamp)" }),
		includeArchived: z
			.enum(["true", "false"])
			.optional()
			.meta({ description: "Include archived chats (default false)" }),
	})
	.meta({ id: "ListChatsQuery" })

export const ListChatsResponseSchema = z
	.object({
		chats: z.array(ChatItemSchema),
		hasMore: z
			.boolean()
			.meta({ description: "Whether there are more results" }),
		nextCursor: z
			.string()
			.nullable()
			.meta({ description: "Cursor for next page" }),
	})
	.meta({ id: "ListChatsResponse" })

// --- GET /chats/:id ---

export const ChatDetailResponseSchema = z
	.object({
		id: z.string().uuid(),
		userId: z.string(),
		title: z.string(),
		repo: z.string().nullable(),
		sourceRepoId: z.string().uuid().nullable(),
		archivedAt: z.string().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
		runs: z.array(WorkflowRunItemSchema),
	})
	.meta({ id: "ChatDetail" })

export const ChatErrorSchema = z
	.object({
		error: z.string().meta({ example: "Not found" }),
	})
	.meta({ id: "ChatError" })
