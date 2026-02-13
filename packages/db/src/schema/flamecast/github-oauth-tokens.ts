import { integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import type { z } from "zod"

export const flamecastSchema = pgSchema("flamecast")

export const githubOauthTokens = flamecastSchema.table("github_oauth_tokens", {
	userId: text("user_id").primaryKey(),
	accessToken: text("access_token").notNull(),
	refreshToken: text("refresh_token").notNull().default(""),
	expiresAt: integer("expires_at").notNull().default(0),
	scopes: text("scopes").array().notNull(),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at")
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date()),
})

export const insertGithubOauthTokenSchema =
	createInsertSchema(githubOauthTokens)
export const selectGithubOauthTokenSchema =
	createSelectSchema(githubOauthTokens)

export type SelectGithubOauthToken = z.infer<
	typeof selectGithubOauthTokenSchema
>
export type InsertGithubOauthToken = z.infer<
	typeof insertGithubOauthTokenSchema
>
