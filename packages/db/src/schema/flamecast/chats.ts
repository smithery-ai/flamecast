import { index, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import type { z } from "zod"
import { flamecastSchema } from "./github-oauth-tokens.js"
import { flamecastUserSourceRepos } from "./user-source-repos.js"

export const flamecastChats = flamecastSchema.table(
	"chats",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: text("user_id").notNull(),
		title: text("title").notNull(),
		repo: text("repo"),
		sourceRepoId: uuid("source_repo_id").references(
			() => flamecastUserSourceRepos.id,
		),
		archivedAt: timestamp("archived_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at")
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	table => [
		index("flamecast_chats_user_id_idx").on(table.userId),
		index("flamecast_chats_repo_idx").on(table.repo),
	],
)

export const insertFlamecastChatSchema = createInsertSchema(flamecastChats)
export const selectFlamecastChatSchema = createSelectSchema(flamecastChats)

export type SelectFlamecastChat = z.infer<typeof selectFlamecastChatSchema>
export type InsertFlamecastChat = z.infer<typeof insertFlamecastChatSchema>
