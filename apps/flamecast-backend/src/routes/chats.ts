import { Hono } from "hono"
import { and, count, desc, eq, isNull, lt, sql } from "drizzle-orm"
import { validator as zValidator } from "hono-openapi"
import {
	flamecastChats,
	flamecastWorkflowRuns,
	flamecastUserSourceRepos,
} from "@smithery/flamecast-db/schema"
import {
	CreateChatRequestSchema,
	ChatIdParamSchema,
	UpdateChatRequestSchema,
	ListChatsQuerySchema,
} from "@smithery/flamecast/schemas"
import { createDbFromUrl } from "../lib/db"
import { authenticateApiKey } from "../lib/auth"
import type { Bindings } from "../index"

const chats = new Hono<{ Bindings: Bindings }>()

// POST / — Create a new chat
chats.post("/", zValidator("json", CreateChatRequestSchema), async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)
	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const { title, repo, sourceRepoId } = c.req.valid("json")

	const [created] = await db
		.insert(flamecastChats)
		.values({
			userId: authRow.userId,
			title,
			repo,
			sourceRepoId,
		})
		.returning({ id: flamecastChats.id })

	return c.json({ success: true as const, id: created.id })
})

// GET / — List chats for the authenticated user
chats.get("/", zValidator("query", ListChatsQuerySchema), async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)
	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const {
		repo: repoFilter,
		limit: limitParam,
		cursor,
		includeArchived,
	} = c.req.valid("query")
	const limit = limitParam ?? 10

	const conditions = [eq(flamecastChats.userId, authRow.userId)]
	if (repoFilter) {
		conditions.push(eq(flamecastChats.repo, repoFilter))
	}
	if (includeArchived !== "true") {
		conditions.push(isNull(flamecastChats.archivedAt))
	}
	if (cursor) {
		conditions.push(lt(flamecastChats.updatedAt, new Date(cursor)))
	}

	// Fetch chats with summary info from latest workflow run
	const chatRows = await db
		.select({
			id: flamecastChats.id,
			userId: flamecastChats.userId,
			title: flamecastChats.title,
			repo: flamecastChats.repo,
			sourceRepoId: flamecastChats.sourceRepoId,
			archivedAt: flamecastChats.archivedAt,
			createdAt: flamecastChats.createdAt,
			updatedAt: flamecastChats.updatedAt,
		})
		.from(flamecastChats)
		.where(and(...conditions))
		.orderBy(desc(flamecastChats.updatedAt))
		.limit(limit + 1)

	const hasMore = chatRows.length > limit
	const items = hasMore ? chatRows.slice(0, limit) : chatRows

	// For each chat, get summary info (run count, latest prompt, status)
	const chatsWithSummary = await Promise.all(
		items.map(async chat => {
			const runs = await db
				.select({
					prompt: flamecastWorkflowRuns.prompt,
					completedAt: flamecastWorkflowRuns.completedAt,
					errorAt: flamecastWorkflowRuns.errorAt,
					startedAt: flamecastWorkflowRuns.startedAt,
				})
				.from(flamecastWorkflowRuns)
				.where(eq(flamecastWorkflowRuns.chatId, chat.id))
				.orderBy(desc(flamecastWorkflowRuns.createdAt))
				.limit(1)

			const [countResult] = await db
				.select({ count: count() })
				.from(flamecastWorkflowRuns)
				.where(eq(flamecastWorkflowRuns.chatId, chat.id))

			const latestRun = runs[0]
			let latestRunStatus: "running" | "completed" | "error" | "queued" | null =
				null
			if (latestRun) {
				if (latestRun.errorAt) latestRunStatus = "error"
				else if (latestRun.completedAt) latestRunStatus = "completed"
				else if (latestRun.startedAt) latestRunStatus = "running"
				else latestRunStatus = "queued"
			}

			return {
				...chat,
				lastPrompt: latestRun?.prompt ?? null,
				runCount: countResult.count,
				latestRunStatus,
			}
		}),
	)

	const nextCursor =
		hasMore && items.length > 0 ? items[items.length - 1].updatedAt : null

	return c.json({
		chats: chatsWithSummary,
		hasMore,
		nextCursor,
	})
})

// GET /:id — Get chat detail with all its workflow runs
chats.get("/:id", zValidator("param", ChatIdParamSchema), async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)
	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const { id } = c.req.valid("param")

	const [chat] = await db
		.select()
		.from(flamecastChats)
		.where(
			and(
				eq(flamecastChats.id, id),
				eq(flamecastChats.userId, authRow.userId),
			),
		)
		.limit(1)

	if (!chat) return c.json({ error: "Not found" }, 404)

	const runs = await db
		.select({
			id: flamecastWorkflowRuns.id,
			workflowRunId: flamecastWorkflowRuns.workflowRunId,
			userId: flamecastWorkflowRuns.userId,
			repo: flamecastWorkflowRuns.repo,
			sourceRepo: flamecastUserSourceRepos.sourceRepo,
			prompt: flamecastWorkflowRuns.prompt,
			prUrl: flamecastWorkflowRuns.prUrl,
			errorMessage: flamecastWorkflowRuns.errorMessage,
			startedAt: flamecastWorkflowRuns.startedAt,
			completedAt: flamecastWorkflowRuns.completedAt,
			errorAt: flamecastWorkflowRuns.errorAt,
			archivedAt: flamecastWorkflowRuns.archivedAt,
			createdAt: flamecastWorkflowRuns.createdAt,
			chatId: flamecastWorkflowRuns.chatId,
		})
		.from(flamecastWorkflowRuns)
		.leftJoin(
			flamecastUserSourceRepos,
			eq(flamecastWorkflowRuns.sourceRepoId, flamecastUserSourceRepos.id),
		)
		.where(eq(flamecastWorkflowRuns.chatId, id))
		.orderBy(flamecastWorkflowRuns.createdAt)

	return c.json({
		...chat,
		runs,
	})
})

// PATCH /:id — Update chat title
chats.patch("/:id", zValidator("param", ChatIdParamSchema), zValidator("json", UpdateChatRequestSchema), async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)
	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const { id } = c.req.valid("param")
	const { title } = c.req.valid("json")

	const updateFields: Record<string, unknown> = {
		updatedAt: new Date(),
	}
	if (title) updateFields.title = title

	const [updated] = await db
		.update(flamecastChats)
		.set(updateFields)
		.where(
			and(
				eq(flamecastChats.id, id),
				eq(flamecastChats.userId, authRow.userId),
			),
		)
		.returning({ id: flamecastChats.id })

	if (!updated) return c.json({ error: "Not found" }, 404)

	return c.json({ success: true as const })
})

// PATCH /:id/archive — Archive a chat
chats.patch("/:id/archive", zValidator("param", ChatIdParamSchema), async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)
	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const { id } = c.req.valid("param")

	const [updated] = await db
		.update(flamecastChats)
		.set({ archivedAt: new Date() })
		.where(
			and(
				eq(flamecastChats.id, id),
				eq(flamecastChats.userId, authRow.userId),
			),
		)
		.returning({ id: flamecastChats.id })

	if (!updated) return c.json({ error: "Not found" }, 404)

	return c.json({ success: true as const })
})

// PATCH /:id/unarchive — Unarchive a chat
chats.patch("/:id/unarchive", zValidator("param", ChatIdParamSchema), async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)
	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const { id } = c.req.valid("param")

	const [updated] = await db
		.update(flamecastChats)
		.set({ archivedAt: null })
		.where(
			and(
				eq(flamecastChats.id, id),
				eq(flamecastChats.userId, authRow.userId),
			),
		)
		.returning({ id: flamecastChats.id })

	if (!updated) return c.json({ error: "Not found" }, 404)

	return c.json({ success: true as const })
})

export default chats
