import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import type { z } from "zod"
import { flamecastSchema } from "./github-oauth-tokens.js"

export const flamecastUserSourceRepos = flamecastSchema.table(
	"user_source_repos",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: text("user_id").notNull(),
		sourceRepo: text("source_repo").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	table => [
		index("flamecast_user_source_repos_user_id_idx").on(table.userId),
		uniqueIndex("flamecast_user_source_repos_user_repo_idx").on(
			table.userId,
			table.sourceRepo,
		),
	],
)

export const insertFlamecastUserSourceRepoSchema = createInsertSchema(
	flamecastUserSourceRepos,
)
export const selectFlamecastUserSourceRepoSchema = createSelectSchema(
	flamecastUserSourceRepos,
)

export type SelectFlamecastUserSourceRepo = z.infer<
	typeof selectFlamecastUserSourceRepoSchema
>
export type InsertFlamecastUserSourceRepo = z.infer<
	typeof insertFlamecastUserSourceRepoSchema
>
