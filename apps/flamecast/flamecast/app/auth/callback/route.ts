import { handleAuth } from "@workos-inc/authkit-nextjs"
import { githubOauthTokens } from "@smithery/db-ps/schema"
import { getDb } from "@/lib/db"
import { getPostHogClient } from "@/lib/posthog-server"

export const GET = handleAuth({
	onSuccess: async ({ user, oauthTokens }) => {
		// Track user sign-in with PostHog (server-side)
		const posthog = getPostHogClient()
		posthog.identify({
			distinctId: user.id,
			properties: {
				email: user.email ?? undefined,
				first_name: user.firstName ?? undefined,
				last_name: user.lastName ?? undefined,
			},
		})
		posthog.capture({
			distinctId: user.id,
			event: "user_signed_in",
			properties: {
				has_oauth_tokens: !!oauthTokens,
			},
		})

		if (!oauthTokens) return

		try {
			const db = getDb()
			await db
				.insert(githubOauthTokens)
				.values({
					userId: user.id,
					accessToken: oauthTokens.accessToken,
					refreshToken: oauthTokens.refreshToken ?? "",
					expiresAt: oauthTokens.expiresAt ?? 0,
					scopes: oauthTokens.scopes ?? [],
				})
				.onConflictDoUpdate({
					target: githubOauthTokens.userId,
					set: {
						accessToken: oauthTokens.accessToken,
						refreshToken: oauthTokens.refreshToken ?? "",
						expiresAt: oauthTokens.expiresAt ?? 0,
						scopes: oauthTokens.scopes ?? [],
					},
				})
		} catch (error) {
			console.error("Failed to upsert GitHub OAuth token:", error)
			posthog.captureException(error, user.id)
		}
	},
})
