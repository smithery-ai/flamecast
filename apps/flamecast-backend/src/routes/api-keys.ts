import { Hono } from "hono"
import { eq, and } from "drizzle-orm"
import { z } from "zod"
import { validator as zValidator } from "hono-openapi"
import { flamecastApiKeys } from "@smithery/flamecast-db/schema"
import { createDbFromUrl } from "../lib/db"
import { authenticateApiKey } from "../lib/auth"
import type { Bindings } from "../index"

const MAX_API_KEYS = 20

const CreateApiKeyRequestSchema = z.object({
	name: z.string().optional(),
	description: z.string().optional(),
})

const ApiKeyIdParamSchema = z.object({
	id: z.string().uuid(),
})

const apiKeys = new Hono<{ Bindings: Bindings }>()

// GET / — List API keys for the authenticated user
apiKeys.get("/", async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)

	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const keys = await db
		.select({
			id: flamecastApiKeys.id,
			name: flamecastApiKeys.name,
			description: flamecastApiKeys.description,
			createdAt: flamecastApiKeys.createdAt,
		})
		.from(flamecastApiKeys)
		.where(eq(flamecastApiKeys.userId, authRow.userId))
		.orderBy(flamecastApiKeys.createdAt)

	return c.json({ keys })
})

// POST / — Create a new API key
apiKeys.post("/", zValidator("json", CreateApiKeyRequestSchema), async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)

	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const { name, description } = c.req.valid("json")

	const existing = await db
		.select({ id: flamecastApiKeys.id })
		.from(flamecastApiKeys)
		.where(eq(flamecastApiKeys.userId, authRow.userId))

	if (existing.length >= MAX_API_KEYS) {
		return c.json({ error: "Maximum number of API keys reached (20)" }, 400)
	}

	const [newKey] = await db
		.insert(flamecastApiKeys)
		.values({
			userId: authRow.userId,
			name: name || null,
			description: description || null,
		})
		.returning({
			id: flamecastApiKeys.id,
			key: flamecastApiKeys.key,
		})

	return c.json({ key: newKey.key, id: newKey.id })
})

// DELETE /:id — Delete an API key
apiKeys.delete("/:id", zValidator("param", ApiKeyIdParamSchema), async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)

	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const { id } = c.req.valid("param")

	await db
		.delete(flamecastApiKeys)
		.where(
			and(
				eq(flamecastApiKeys.id, id),
				eq(flamecastApiKeys.userId, authRow.userId),
			),
		)

	return c.json({ success: true })
})

export default apiKeys
