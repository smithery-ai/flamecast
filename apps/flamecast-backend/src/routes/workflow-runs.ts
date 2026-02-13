import { Hono } from "hono"
import { describeRoute, resolver, validator as zValidator } from "hono-openapi"
import { and, desc, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { strFromU8, unzipSync } from "fflate"
import { z } from "zod"
import {
	flamecastApiKeys,
	flamecastUserSourceRepos,
	flamecastWorkflowRuns,
	githubOauthTokens,
} from "@smithery/flamecast-db/schema"
import {
	CreateWorkflowRunRequestSchema,
	CreateWorkflowRunResponseSchema,
	WorkflowRunErrorSchema,
	WorkflowRunIdParamSchema,
	PatchWorkflowRunResponseSchema,
	ListWorkflowRunsQuerySchema,
	ListWorkflowRunsResponseSchema,
} from "@smithery/flamecast/schemas"

type Bindings = {
	DATABASE_URL: string
}

const GitHubRunQuerySchema = z.object({
	owner: z.string().min(1),
	repo: z.string().min(1),
	runId: z.coerce.number().int().positive(),
})

const GitHubRunResponseSchema = z.object({
	id: z.number().int().positive(),
	html_url: z.string().url(),
	status: z.string().nullable(),
	conclusion: z.string().nullable(),
	run_started_at: z.string().nullable(),
	updated_at: z.string(),
})

const GitHubRunJobSchema = z.object({
	id: z.number().int().positive(),
	name: z.string(),
	status: z.string().nullable(),
	conclusion: z.string().nullable(),
})

const GitHubRunJobsResponseSchema = z.object({
	jobs: z.array(GitHubRunJobSchema),
})

const GitHubRunLogsResponseSchema = z.object({
	downloadUrl: z.string().nullable(),
	content: z.string().nullable(),
	truncated: z.boolean(),
})

const GitHubRunOutputsResponseSchema = z.object({
	available: z.boolean(),
	prUrl: z.string().nullable(),
	claudeLogs: z.string().nullable(),
	claudeLogsTruncated: z.boolean(),
})

const GitHubCheckRunSchema = z.object({
	id: z.number(),
	name: z.string(),
	status: z.string(),
	conclusion: z.string().nullable(),
	html_url: z.string().nullable(),
	started_at: z.string().nullable(),
	completed_at: z.string().nullable(),
})

const GitHubCheckRunsResponseSchema = z.object({
	checks: z.array(GitHubCheckRunSchema),
})

const GitHubJobsApiResponseSchema = z.object({
	jobs: z.array(
		z.object({
			id: z.number(),
			name: z.string(),
			status: z.string().nullable(),
			conclusion: z.string().nullable(),
		}),
	),
})

const GitHubArtifactsApiResponseSchema = z.object({
	artifacts: z
		.array(
			z.object({
				name: z.string(),
				expired: z.boolean(),
				created_at: z.string().nullable(),
				archive_download_url: z.string(),
			}),
		)
		.optional(),
})

const workflowRuns = new Hono<{ Bindings: Bindings }>()
const OUTPUT_ARTIFACT_NAME = "flamecast-outputs"
const MAX_CLAUDE_LOGS_CHARS = 200_000
const MAX_WORKFLOW_LOG_CHARS = 300_000

const DEFAULT_LOGS = GitHubRunLogsResponseSchema.parse({
	downloadUrl: null,
	content: null,
	truncated: false,
})

const DEFAULT_OUTPUTS = GitHubRunOutputsResponseSchema.parse({
	available: false,
	prUrl: null,
	claudeLogs: null,
	claudeLogsTruncated: false,
})

async function authenticateApiKey(
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

async function getGitHubAccessToken(
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

function getGitHubHeaders(accessToken: string) {
	return {
		Authorization: `token ${accessToken}`,
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "flamecast-backend",
	}
}

// POST / — Register a workflow run, return the DB UUID
workflowRuns.post(
	"/",
	describeRoute({
		tags: ["workflow-runs"],
		summary: "Register a workflow run",
		description:
			"Register a new GitHub Actions workflow run triggered by Flamecast.",
		responses: {
			200: {
				description: "Workflow run registered successfully",
				content: {
					"application/json": {
						schema: resolver(CreateWorkflowRunResponseSchema),
					},
				},
			},
			400: {
				description: "Invalid request body",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			401: {
				description: "Unauthorized",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
		},
	}),
	zValidator("json", CreateWorkflowRunRequestSchema),
	async c => {
		const client = postgres(c.env.DATABASE_URL, { prepare: false })
		const db = drizzle(client)

		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { workflowRunId, repo, sourceRepo, prompt } = c.req.valid("json")

		const normalizedPrompt =
			typeof prompt === "string" && prompt.trim().length > 0
				? prompt.trim()
				: undefined

		// Upsert source repo if provided
		let sourceRepoId: string | undefined
		if (sourceRepo) {
			const [sourceRepoRow] = await db
				.insert(flamecastUserSourceRepos)
				.values({
					userId: authRow.userId,
					sourceRepo,
				})
				.onConflictDoUpdate({
					target: [
						flamecastUserSourceRepos.userId,
						flamecastUserSourceRepos.sourceRepo,
					],
					set: { createdAt: new Date() },
				})
				.returning({ id: flamecastUserSourceRepos.id })
			sourceRepoId = sourceRepoRow.id
		}

		const [inserted] = await db
			.insert(flamecastWorkflowRuns)
			.values({
				workflowRunId,
				userId: authRow.userId,
				repo,
				sourceRepoId,
				prompt: normalizedPrompt,
				startedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: [
					flamecastWorkflowRuns.workflowRunId,
					flamecastWorkflowRuns.userId,
				],
				set: {
					startedAt: new Date(),
					...(repo ? { repo } : {}),
					...(sourceRepoId ? { sourceRepoId } : {}),
					...(normalizedPrompt ? { prompt: normalizedPrompt } : {}),
				},
			})
			.returning({ id: flamecastWorkflowRuns.id })

		return c.json({ success: true as const, id: inserted.id })
	},
)

workflowRuns.get(
	"/github-run",
	describeRoute({
		tags: ["workflow-runs"],
		summary: "Get GitHub workflow run",
		description:
			"Fetch a single GitHub Actions workflow run by owner/repo/runId.",
		responses: {
			200: {
				description: "Workflow run details",
				content: {
					"application/json": {
						schema: resolver(GitHubRunResponseSchema),
					},
				},
			},
			400: {
				description: "Invalid query parameters",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			401: {
				description: "Unauthorized",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			403: {
				description: "GitHub token not found",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			404: {
				description: "Workflow run not found on GitHub",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
		},
	}),
	zValidator("query", GitHubRunQuerySchema),
	async c => {
		const client = postgres(c.env.DATABASE_URL, { prepare: false })
		const db = drizzle(client)

		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) {
			return c.json(
				WorkflowRunErrorSchema.parse({ error: "Unauthorized" }),
				401,
			)
		}

		const { owner, repo, runId } = c.req.valid("query")
		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) {
			return c.json(
				WorkflowRunErrorSchema.parse({ error: "GitHub token not found" }),
				403,
			)
		}

		const runRes = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`,
			{
				headers: getGitHubHeaders(accessToken),
			},
		)

		if (!runRes.ok) {
			const message = await runRes.text()
			return Response.json(
				WorkflowRunErrorSchema.parse({ error: message || "GitHub API error" }),
				{ status: runRes.status },
			)
		}

		const parsedRun = GitHubRunResponseSchema.safeParse(await runRes.json())
		if (!parsedRun.success) {
			return c.json(
				WorkflowRunErrorSchema.parse({
					error: "Invalid GitHub run response",
				}),
				502,
			)
		}

		return c.json(parsedRun.data)
	},
)

workflowRuns.get(
	"/github-run/jobs",
	describeRoute({
		tags: ["workflow-runs"],
		summary: "Get GitHub workflow run jobs",
		description: "Fetch jobs for a GitHub Actions workflow run.",
		responses: {
			200: {
				description: "Workflow run jobs",
				content: {
					"application/json": {
						schema: resolver(GitHubRunJobsResponseSchema),
					},
				},
			},
			400: {
				description: "Invalid query parameters",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			401: {
				description: "Unauthorized",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			403: {
				description: "GitHub token not found",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
		},
	}),
	zValidator("query", GitHubRunQuerySchema),
	async c => {
		const client = postgres(c.env.DATABASE_URL, { prepare: false })
		const db = drizzle(client)

		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) {
			return c.json(
				WorkflowRunErrorSchema.parse({ error: "Unauthorized" }),
				401,
			)
		}

		const { owner, repo, runId } = c.req.valid("query")
		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) {
			return c.json(
				WorkflowRunErrorSchema.parse({ error: "GitHub token not found" }),
				403,
			)
		}

		const jobsRes = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=50`,
			{
				headers: getGitHubHeaders(accessToken),
			},
		)

		if (jobsRes.status === 403 || jobsRes.status === 404) {
			return c.json(GitHubRunJobsResponseSchema.parse({ jobs: [] }))
		}

		if (!jobsRes.ok) {
			const message = await jobsRes.text()
			return Response.json(
				WorkflowRunErrorSchema.parse({ error: message || "GitHub API error" }),
				{ status: jobsRes.status },
			)
		}

		const parsedJobs = GitHubJobsApiResponseSchema.safeParse(
			await jobsRes.json(),
		)
		if (!parsedJobs.success) {
			return c.json(
				WorkflowRunErrorSchema.parse({
					error: "Invalid GitHub jobs response",
				}),
				502,
			)
		}

		return c.json(
			GitHubRunJobsResponseSchema.parse({
				jobs: parsedJobs.data.jobs.map(job => ({
					id: job.id,
					name: job.name,
					status: job.status,
					conclusion: job.conclusion,
				})),
			}),
		)
	},
)

workflowRuns.get(
	"/github-run/logs",
	describeRoute({
		tags: ["workflow-runs"],
		summary: "Get GitHub workflow run logs",
		description:
			"Fetch downloadable logs URL and inline combined logs for a GitHub workflow run.",
		responses: {
			200: {
				description: "Workflow run logs",
				content: {
					"application/json": {
						schema: resolver(GitHubRunLogsResponseSchema),
					},
				},
			},
			400: {
				description: "Invalid query parameters",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			401: {
				description: "Unauthorized",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			403: {
				description: "GitHub token not found",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
		},
	}),
	zValidator("query", GitHubRunQuerySchema),
	async c => {
		const client = postgres(c.env.DATABASE_URL, { prepare: false })
		const db = drizzle(client)

		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) {
			return c.json(
				WorkflowRunErrorSchema.parse({ error: "Unauthorized" }),
				401,
			)
		}

		const { owner, repo, runId } = c.req.valid("query")
		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) {
			return c.json(
				WorkflowRunErrorSchema.parse({ error: "GitHub token not found" }),
				403,
			)
		}

		const logsUrlRes = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`,
			{
				headers: getGitHubHeaders(accessToken),
				redirect: "manual",
			},
		)

		if (logsUrlRes.status === 403 || logsUrlRes.status === 404) {
			return c.json(DEFAULT_LOGS)
		}

		if (
			!logsUrlRes.ok &&
			(logsUrlRes.status < 300 || logsUrlRes.status >= 400)
		) {
			const message = await logsUrlRes.text()
			return Response.json(
				WorkflowRunErrorSchema.parse({ error: message || "GitHub API error" }),
				{ status: logsUrlRes.status },
			)
		}

		const location = logsUrlRes.headers.get("location")
		const downloadUrl = location || (logsUrlRes.ok ? logsUrlRes.url : null)
		if (!downloadUrl) return c.json(DEFAULT_LOGS)

		const archiveResponse = location ? await fetch(location) : logsUrlRes
		if (!archiveResponse.ok) {
			return c.json(
				GitHubRunLogsResponseSchema.parse({
					downloadUrl,
					content: null,
					truncated: false,
				}),
			)
		}

		let entries: Array<[string, Uint8Array]>
		try {
			const archiveData = new Uint8Array(await archiveResponse.arrayBuffer())
			const extracted = unzipSync(archiveData)
			entries = Object.entries(extracted).sort(([left], [right]) => {
				return left.localeCompare(right)
			})
		} catch {
			return c.json(
				GitHubRunLogsResponseSchema.parse({
					downloadUrl,
					content: null,
					truncated: false,
				}),
			)
		}

		if (entries.length === 0) {
			return c.json(
				GitHubRunLogsResponseSchema.parse({
					downloadUrl,
					content: null,
					truncated: false,
				}),
			)
		}

		const combined = entries
			.map(([name, content]) => {
				return `===== ${name} =====\n${strFromU8(content)}`
			})
			.join("\n\n")

		if (combined.length <= MAX_WORKFLOW_LOG_CHARS) {
			return c.json(
				GitHubRunLogsResponseSchema.parse({
					downloadUrl,
					content: combined,
					truncated: false,
				}),
			)
		}

		return c.json(
			GitHubRunLogsResponseSchema.parse({
				downloadUrl,
				content: combined.slice(0, MAX_WORKFLOW_LOG_CHARS),
				truncated: true,
			}),
		)
	},
)

workflowRuns.get(
	"/github-run/checks",
	describeRoute({
		tags: ["workflow-runs"],
		summary: "Get GitHub PR check runs",
		description:
			"Fetch check runs for a pull request from a GitHub workflow run.",
		responses: {
			200: {
				description: "PR check runs",
				content: {
					"application/json": {
						schema: resolver(GitHubCheckRunsResponseSchema),
					},
				},
			},
			400: {
				description: "Invalid query parameters",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			401: {
				description: "Unauthorized",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			403: {
				description: "GitHub token not found",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
		},
	}),
	zValidator("query", GitHubRunQuerySchema),
	async c => {
		const client = postgres(c.env.DATABASE_URL, { prepare: false })
		const db = drizzle(client)

		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) {
			return c.json(
				WorkflowRunErrorSchema.parse({ error: "Unauthorized" }),
				401,
			)
		}

		const { owner, repo, runId } = c.req.valid("query")
		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) {
			return c.json(
				WorkflowRunErrorSchema.parse({ error: "GitHub token not found" }),
				403,
			)
		}

		// First, get the workflow run to find the associated PR
		const runRes = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`,
			{
				headers: getGitHubHeaders(accessToken),
			},
		)

		if (!runRes.ok) {
			return c.json(GitHubCheckRunsResponseSchema.parse({ checks: [] }))
		}

		const runData = await runRes.json<{ head_sha?: string }>()
		const headSha = runData.head_sha

		if (!headSha) {
			return c.json(GitHubCheckRunsResponseSchema.parse({ checks: [] }))
		}

		// Fetch check runs for the commit
		const checksRes = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs`,
			{
				headers: getGitHubHeaders(accessToken),
			},
		)

		if (!checksRes.ok) {
			return c.json(GitHubCheckRunsResponseSchema.parse({ checks: [] }))
		}

		const checksData = await checksRes.json<{ check_runs?: { id: number; name: string; status: string; conclusion: string | null; html_url: string; started_at: string | null; completed_at: string | null }[] }>()
		const checkRuns = checksData.check_runs || []

		return c.json(
			GitHubCheckRunsResponseSchema.parse({
				checks: checkRuns.map((check) => ({
					id: check.id,
					name: check.name,
					status: check.status,
					conclusion: check.conclusion,
					html_url: check.html_url,
					started_at: check.started_at,
					completed_at: check.completed_at,
				})),
			}),
		)
	},
)

workflowRuns.get(
	"/github-run/outputs",
	describeRoute({
		tags: ["workflow-runs"],
		summary: "Get GitHub workflow run outputs artifact",
		description:
			"Fetch and parse flamecast outputs artifact for a GitHub workflow run.",
		responses: {
			200: {
				description: "Workflow outputs",
				content: {
					"application/json": {
						schema: resolver(GitHubRunOutputsResponseSchema),
					},
				},
			},
			400: {
				description: "Invalid query parameters",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			401: {
				description: "Unauthorized",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			403: {
				description: "GitHub token not found",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
		},
	}),
	zValidator("query", GitHubRunQuerySchema),
	async c => {
		const client = postgres(c.env.DATABASE_URL, { prepare: false })
		const db = drizzle(client)

		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) {
			return c.json(
				WorkflowRunErrorSchema.parse({ error: "Unauthorized" }),
				401,
			)
		}

		const { owner, repo, runId } = c.req.valid("query")
		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) {
			return c.json(
				WorkflowRunErrorSchema.parse({ error: "GitHub token not found" }),
				403,
			)
		}

		const artifactsRes = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
			{
				headers: getGitHubHeaders(accessToken),
			},
		)

		if (artifactsRes.status === 403 || artifactsRes.status === 404) {
			return c.json(DEFAULT_OUTPUTS)
		}

		if (!artifactsRes.ok) {
			const message = await artifactsRes.text()
			return Response.json(
				WorkflowRunErrorSchema.parse({ error: message || "GitHub API error" }),
				{ status: artifactsRes.status },
			)
		}

		const parsedArtifacts = GitHubArtifactsApiResponseSchema.safeParse(
			await artifactsRes.json(),
		)
		if (!parsedArtifacts.success) {
			return c.json(
				WorkflowRunErrorSchema.parse({
					error: "Invalid GitHub artifacts response",
				}),
				502,
			)
		}

		const artifact = (parsedArtifacts.data.artifacts ?? [])
			.filter(candidate => {
				return (
					candidate.name === OUTPUT_ARTIFACT_NAME && candidate.expired === false
				)
			})
			.sort((left, right) => {
				return (
					Date.parse(right.created_at || "1970-01-01T00:00:00Z") -
					Date.parse(left.created_at || "1970-01-01T00:00:00Z")
				)
			})[0]

		if (!artifact) return c.json(DEFAULT_OUTPUTS)

		const archiveResponse = await fetch(artifact.archive_download_url, {
			headers: getGitHubHeaders(accessToken),
		})
		if (!archiveResponse.ok) return c.json(DEFAULT_OUTPUTS)

		let outputEntry: [string, Uint8Array] | undefined
		try {
			const archiveData = new Uint8Array(await archiveResponse.arrayBuffer())
			const extracted = unzipSync(archiveData)
			outputEntry =
				Object.entries(extracted).find(([name]) =>
					name.endsWith("outputs.json"),
				) || Object.entries(extracted).find(([name]) => name.endsWith(".json"))
		} catch {
			return c.json(DEFAULT_OUTPUTS)
		}

		if (!outputEntry) return c.json(DEFAULT_OUTPUTS)

		let parsed: unknown
		try {
			parsed = JSON.parse(strFromU8(outputEntry[1]))
		} catch {
			return c.json(DEFAULT_OUTPUTS)
		}

		if (!parsed || typeof parsed !== "object") return c.json(DEFAULT_OUTPUTS)

		const outputObject = parsed as {
			pr_url?: unknown
			claude_logs?: unknown
		}

		const prUrl =
			typeof outputObject.pr_url === "string" && outputObject.pr_url.length > 0
				? outputObject.pr_url
				: null

		const fullClaudeLogs =
			typeof outputObject.claude_logs === "string"
				? outputObject.claude_logs
				: null
		const claudeLogsTruncated =
			!!fullClaudeLogs && fullClaudeLogs.length > MAX_CLAUDE_LOGS_CHARS

		return c.json(
			GitHubRunOutputsResponseSchema.parse({
				available: true,
				prUrl,
				claudeLogs: fullClaudeLogs
					? fullClaudeLogs.slice(0, MAX_CLAUDE_LOGS_CHARS)
					: null,
				claudeLogsTruncated,
			}),
		)
	},
)

// PATCH /:id — Completion callback, infers status from GitHub API
workflowRuns.patch(
	"/:id",
	describeRoute({
		tags: ["workflow-runs"],
		summary: "Complete a workflow run",
		description:
			"Check GitHub Actions status and update the workflow run record.",
		responses: {
			200: {
				description: "Workflow run status updated",
				content: {
					"application/json": {
						schema: resolver(PatchWorkflowRunResponseSchema),
					},
				},
			},
			401: {
				description: "Unauthorized",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
			404: {
				description: "Workflow run not found",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
		},
	}),
	zValidator("param", WorkflowRunIdParamSchema),
	async c => {
		const client = postgres(c.env.DATABASE_URL, { prepare: false })
		const db = drizzle(client)

		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { id } = c.req.valid("param")

		// Look up workflow run with source repo
		const [run] = await db
			.select({
				id: flamecastWorkflowRuns.id,
				workflowRunId: flamecastWorkflowRuns.workflowRunId,
				userId: flamecastWorkflowRuns.userId,
				repo: flamecastWorkflowRuns.repo,
				sourceRepo: flamecastUserSourceRepos.sourceRepo,
				completedAt: flamecastWorkflowRuns.completedAt,
				errorAt: flamecastWorkflowRuns.errorAt,
			})
			.from(flamecastWorkflowRuns)
			.leftJoin(
				flamecastUserSourceRepos,
				eq(flamecastWorkflowRuns.sourceRepoId, flamecastUserSourceRepos.id),
			)
			.where(
				and(
					eq(flamecastWorkflowRuns.id, id),
					eq(flamecastWorkflowRuns.userId, authRow.userId),
				),
			)
			.limit(1)

		if (!run) return c.json({ error: "Not found" }, 404)

		// Already resolved
		if (run.completedAt || run.errorAt)
			return c.json({ success: true as const, alreadyResolved: true })

		// Get user's GitHub token
		const accessToken = await getGitHubAccessToken(db, run.userId)

		if (!accessToken || !run.sourceRepo) {
			// Can't infer without GitHub token or source repo — mark as error
			await db
				.update(flamecastWorkflowRuns)
				.set({
					errorAt: new Date(),
					errorMessage:
						"Unable to infer status: missing GitHub token or source repo",
				})
				.where(eq(flamecastWorkflowRuns.id, id))
			return c.json({
				success: true as const,
				status: "error" as const,
			})
		}

		// Call GitHub API to check workflow run jobs
		const jobsRes = await fetch(
			`https://api.github.com/repos/${run.sourceRepo}/actions/runs/${run.workflowRunId}/jobs`,
			{
				headers: {
					Authorization: `token ${accessToken}`,
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "flamecast-backend",
				},
			},
		)

		if (!jobsRes.ok) {
			await db
				.update(flamecastWorkflowRuns)
				.set({
					errorAt: new Date(),
					errorMessage: `GitHub API error: ${jobsRes.status}`,
				})
				.where(eq(flamecastWorkflowRuns.id, id))
			return c.json({
				success: true as const,
				status: "error" as const,
			})
		}

		const jobsData = (await jobsRes.json()) as {
			jobs: Array<{
				steps: Array<{
					name: string
					conclusion: string | null
				}>
				head_branch?: string
			}>
		}

		// Find the flamecast step conclusion
		let conclusion: string | null = null
		let headBranch: string | null = null
		for (const job of jobsData.jobs) {
			headBranch = job.head_branch ?? null
			for (const step of job.steps) {
				if (step.name.toLowerCase().includes("smithery-ai/flamecast")) {
					conclusion = step.conclusion
					break
				}
			}
			if (conclusion) break
		}

		const updateFields: Record<string, unknown> = {}

		if (conclusion === "success") {
			updateFields.completedAt = new Date()

			// Search for PR on target repo
			if (run.repo && headBranch) {
				const [sourceOwner] = run.sourceRepo.split("/")
				const prRes = await fetch(
					`https://api.github.com/repos/${run.repo}/pulls?head=${sourceOwner}:${headBranch}&state=all&per_page=1`,
					{
						headers: {
							Authorization: `token ${accessToken}`,
							Accept: "application/vnd.github.v3+json",
							"User-Agent": "flamecast-backend",
						},
					},
				)
				if (prRes.ok) {
					const prs = (await prRes.json()) as Array<{
						html_url: string
					}>
					if (prs.length > 0) {
						updateFields.prUrl = prs[0].html_url
					}
				}
			}
		} else if (
			conclusion === "failure" ||
			conclusion === "cancelled" ||
			conclusion === "timed_out"
		) {
			updateFields.errorAt = new Date()
			updateFields.errorMessage = `Workflow step ${conclusion}`
		} else {
			// Step hasn't completed yet or couldn't find it — don't update
			return c.json({
				success: true as const,
				status: "pending" as const,
			})
		}

		if (Object.keys(updateFields).length > 0) {
			await db
				.update(flamecastWorkflowRuns)
				.set(updateFields)
				.where(eq(flamecastWorkflowRuns.id, id))
		}

		return c.json({
			success: true as const,
			status:
				conclusion === "success" ? ("completed" as const) : ("error" as const),
		})
	},
)

// GET / — List workflow runs for the authenticated user (API key auth)
workflowRuns.get(
	"/",
	describeRoute({
		tags: ["workflow-runs"],
		summary: "List workflow runs",
		description:
			"List workflow runs for the authenticated user, optionally filtered by repository.",
		responses: {
			200: {
				description: "List of workflow runs",
				content: {
					"application/json": {
						schema: resolver(ListWorkflowRunsResponseSchema),
					},
				},
			},
			401: {
				description: "Unauthorized",
				content: {
					"application/json": {
						schema: resolver(WorkflowRunErrorSchema),
					},
				},
			},
		},
	}),
	zValidator("query", ListWorkflowRunsQuerySchema),
	async c => {
		const client = postgres(c.env.DATABASE_URL, { prepare: false })
		const db = drizzle(client)

		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { repo: repoFilter, limit: limitParam } = c.req.valid("query")
		const limit = limitParam ?? 20

		const conditions = [eq(flamecastWorkflowRuns.userId, authRow.userId)]
		if (repoFilter) {
			conditions.push(eq(flamecastWorkflowRuns.repo, repoFilter))
		}

		const runs = await db
			.select({
				id: flamecastWorkflowRuns.id,
				workflowRunId: flamecastWorkflowRuns.workflowRunId,
				userId: flamecastWorkflowRuns.userId,
				repo: flamecastWorkflowRuns.repo,
				sourceRepo: flamecastUserSourceRepos.sourceRepo,
				prompt: flamecastWorkflowRuns.prompt,
				prUrl: flamecastWorkflowRuns.prUrl,
				errorMessage: flamecastWorkflowRuns.errorMessage,
				startedAt: flamecastWorkflowRuns.startedAt,
				completedAt: flamecastWorkflowRuns.completedAt,
				errorAt: flamecastWorkflowRuns.errorAt,
				createdAt: flamecastWorkflowRuns.createdAt,
			})
			.from(flamecastWorkflowRuns)
			.leftJoin(
				flamecastUserSourceRepos,
				eq(flamecastWorkflowRuns.sourceRepoId, flamecastUserSourceRepos.id),
			)
			.where(and(...conditions))
			.orderBy(desc(flamecastWorkflowRuns.createdAt))
			.limit(limit)

		return c.json(runs)
	},
)

export default workflowRuns
