import { withAuth } from "@workos-inc/authkit-nextjs"
import { eq } from "drizzle-orm"
import { githubOauthTokens } from "@smithery/flamecast-db/schema"
import { getDb } from "@/lib/db"

export async function getGitHubCredentials() {
	const { user } = await withAuth()
	if (!user) return null

	try {
		const db = getDb()
		const [token] = await db
			.select({ accessToken: githubOauthTokens.accessToken })
			.from(githubOauthTokens)
			.where(eq(githubOauthTokens.userId, user.id))
			.limit(1)

		if (!token) return null
		return { accessToken: token.accessToken, userId: user.id }
	} catch (error) {
		console.error("Failed to read GitHub OAuth token:", error)
		return null
	}
}
