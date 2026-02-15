import { eq } from "drizzle-orm"
import type { drizzle } from "drizzle-orm/postgres-js"
import {
	flamecastApiKeys,
	githubOauthTokens,
} from "@smithery/flamecast-db/schema"

export async function authenticateApiKey(
	db: ReturnType<typeof drizzle>,
	authHeader: string | undefined,
) {
	if (!authHeader) return null

	const match = authHeader.match(/^Bearer\s+(.+)$/i)
	if (!match) return null

	const apiKey = match[1]
	const uuidRegex =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
	if (!uuidRegex.test(apiKey)) return null

	const [row] = await db
		.select({ id: flamecastApiKeys.id, userId: flamecastApiKeys.userId })
		.from(flamecastApiKeys)
		.where(eq(flamecastApiKeys.key, apiKey))
		.limit(1)

	return row ?? null
}

export async function getGitHubAccessToken(
	db: ReturnType<typeof drizzle>,
	userId: string,
) {
	const [tokenRow] = await db
		.select({ accessToken: githubOauthTokens.accessToken })
		.from(githubOauthTokens)
		.where(eq(githubOauthTokens.userId, userId))
		.limit(1)

	return tokenRow?.accessToken ?? null
}

export function getGitHubHeaders(accessToken: string) {
	return {
		Authorization: `token ${accessToken}`,
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "flamecast-backend",
	}
}
