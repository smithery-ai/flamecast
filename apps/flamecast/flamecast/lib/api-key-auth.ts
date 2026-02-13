import { eq } from "drizzle-orm"
import { flamecastApiKeys } from "@smithery/db-ps/schema"
import { getDb } from "@/lib/db"

export interface ApiKeyCredentials {
	apiKeyId: string
	userId: string
}

export async function getApiKeyCredentials(
	request: Request,
): Promise<ApiKeyCredentials | null> {
	const authHeader = request.headers.get("authorization")
	if (!authHeader) return null

	const match = authHeader.match(/^Bearer\s+(.+)$/i)
	if (!match) return null

	const apiKey = match[1]
	const db = getDb()

	const [row] = await db
		.select({
			id: flamecastApiKeys.id,
			userId: flamecastApiKeys.userId,
		})
		.from(flamecastApiKeys)
		.where(eq(flamecastApiKeys.key, apiKey))
		.limit(1)

	if (!row) return null
	return { apiKeyId: row.id, userId: row.userId }
}

export async function getUserApiKey(userId: string): Promise<string | null> {
	const db = getDb()
	const [row] = await db
		.select({ key: flamecastApiKeys.key })
		.from(flamecastApiKeys)
		.where(eq(flamecastApiKeys.userId, userId))
		.limit(1)
	return row?.key ?? null
}
