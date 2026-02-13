import { index, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import type { z } from "zod"
import { flamecastSchema } from "./github-oauth-tokens.js"

export const flamecastApiKeys = flamecastSchema.table(
	"api_keys",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		key: uuid("api_key").notNull().unique().defaultRandom(),
		userId: text("user_id").notNull(),
		name: text("name"),
		description: text("description"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	table => [index("flamecast_api_keys_user_id_idx").on(table.userId)],
)

export const insertFlamecastApiKeySchema = createInsertSchema(flamecastApiKeys)
export const selectFlamecastApiKeySchema = createSelectSchema(flamecastApiKeys)

export type SelectFlamecastApiKey = z.infer<typeof selectFlamecastApiKeySchema>
export type InsertFlamecastApiKey = z.infer<typeof insertFlamecastApiKeySchema>
