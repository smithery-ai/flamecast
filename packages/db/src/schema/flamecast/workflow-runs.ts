import {
	bigint,
	index,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import type { z } from "zod"
import { flamecastSchema } from "./github-oauth-tokens.js"
import { flamecastUserSourceRepos } from "./user-source-repos.js"

export const flamecastWorkflowRuns = flamecastSchema.table(
	"workflow_runs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workflowRunId: bigint("workflow_run_id", { mode: "number" }).notNull(),
		userId: text("user_id").notNull(),
		prUrl: text("pr_url"),
		repo: text("repo"),
		sourceRepoId: uuid("source_repo_id").references(
			() => flamecastUserSourceRepos.id,
		),
		prompt: text("prompt"),
		errorMessage: text("error_message"),
		startedAt: timestamp("started_at"),
		completedAt: timestamp("completed_at"),
		errorAt: timestamp("error_at"),
		archivedAt: timestamp("archived_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	table => [
		index("flamecast_workflow_runs_user_id_idx").on(table.userId),
		index("flamecast_workflow_runs_run_id_idx").on(table.workflowRunId),
		uniqueIndex("flamecast_workflow_runs_run_id_user_id_idx").on(
			table.workflowRunId,
			table.userId,
		),
		index("flamecast_workflow_runs_repo_idx").on(table.repo),
	],
)

export const insertFlamecastWorkflowRunSchema = createInsertSchema(
	flamecastWorkflowRuns,
)
export const selectFlamecastWorkflowRunSchema = createSelectSchema(
	flamecastWorkflowRuns,
)

export type SelectFlamecastWorkflowRun = z.infer<
	typeof selectFlamecastWorkflowRunSchema
>
export type InsertFlamecastWorkflowRun = z.infer<
	typeof insertFlamecastWorkflowRunSchema
>
