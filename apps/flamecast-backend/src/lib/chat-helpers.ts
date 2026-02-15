import type { drizzle } from "drizzle-orm/postgres-js"
import { eq } from "drizzle-orm"
import { flamecastChats } from "@smithery/flamecast-db/schema"

/**
 * Returns an existing chat ID or creates a new one-off chat.
 * Used by both the UI dispatch and workflow self-registration paths.
 */
export async function getOrCreateChat(
	db: ReturnType<typeof drizzle>,
	opts: {
		chatId?: string
		userId: string
		title: string
		repo?: string | null
		sourceRepoId?: string | null
	},
): Promise<string> {
	if (opts.chatId) {
		// Verify the chat exists and belongs to the user
		const [existing] = await db
			.select({ id: flamecastChats.id })
			.from(flamecastChats)
			.where(eq(flamecastChats.id, opts.chatId))
			.limit(1)

		if (existing) return existing.id
	}

	// Create a new chat
	const [created] = await db
		.insert(flamecastChats)
		.values({
			userId: opts.userId,
			title: opts.title.slice(0, 80) || "Untitled",
			repo: opts.repo ?? undefined,
			sourceRepoId: opts.sourceRepoId ?? undefined,
		})
		.returning({ id: flamecastChats.id })

	return created.id
}
