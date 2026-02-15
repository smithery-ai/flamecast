import { Hono } from "hono"
import { z } from "zod"
import { validator as zValidator } from "hono-openapi"
import {
	flamecastUserSourceRepos,
	flamecastWorkflowRuns,
} from "@smithery/flamecast-db/schema"
import { createDbFromUrl } from "../lib/db"
import {
	authenticateApiKey,
	getGitHubAccessToken,
	getGitHubHeaders,
} from "../lib/auth"
import { createPostHogClient } from "../lib/posthog"
import { getOrCreateChat } from "../lib/chat-helpers"
import type { Bindings } from "../index"

const githubRepos = new Hono<{ Bindings: Bindings }>()

const RepoParamSchema = z.object({
	owner: z.string().min(1),
	repo: z.string().min(1),
})

const PullParamSchema = z.object({
	owner: z.string().min(1),
	repo: z.string().min(1),
	number: z.coerce.number().int().positive(),
})

const RunParamSchema = z.object({
	owner: z.string().min(1),
	repo: z.string().min(1),
	runId: z.coerce.number().int().positive(),
})

const DispatchRequestSchema = z.object({
	prompt: z.string().min(1),
	baseBranch: z.string().optional(),
	ref: z.string().optional(),
	targetRepo: z.string().optional(),
	chatId: z.string().uuid().optional(),
})

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

// GET /repos/:owner/:repo/pulls — List Flamecast PRs
githubRepos.get(
	"/repos/:owner/:repo/pulls",
	zValidator("param", RepoParamSchema),
	async c => {
		const db = createDbFromUrl(c.env.DATABASE_URL)
		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { owner, repo } = c.req.valid("param")
		const user = c.req.query("user")

		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

		const prefix = user ? `flamecast/${user}/` : "flamecast/"

		const res = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
			{ headers: getGitHubHeaders(accessToken) },
		)

		if (!res.ok) {
			return c.json(
				{ error: `GitHub API error: ${res.status}` },
				res.status as 400,
			)
		}

		const pulls = (await res.json()) as Array<{
			number: number
			title: string
			head: { ref: string }
			html_url: string
			created_at: string
			updated_at: string
		}>

		const flamecastPRs = pulls
			.filter(pr => pr.head.ref.startsWith(prefix))
			.map(pr => ({
				number: pr.number,
				title: pr.title,
				headRefName: pr.head.ref,
				url: pr.html_url,
				createdAt: pr.created_at,
				updatedAt: pr.updated_at,
			}))

		return c.json(flamecastPRs)
	},
)

// GET /repos/:owner/:repo/pulls/:number/status — PR status with checks
githubRepos.get(
	"/repos/:owner/:repo/pulls/:number/status",
	zValidator("param", PullParamSchema),
	async c => {
		const db = createDbFromUrl(c.env.DATABASE_URL)
		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { owner, repo, number } = c.req.valid("param")

		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

		const headers = getGitHubHeaders(accessToken)

		const prRes = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
			{ headers },
		)
		if (!prRes.ok)
			return c.json(
				{ error: `GitHub API error: ${prRes.status}` },
				prRes.status as 400,
			)

		const pr = (await prRes.json()) as {
			state: string
			merged: boolean
			mergeable: boolean | null
			head: { sha: string }
		}

		const checksRes = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
			{ headers },
		)

		let checkRuns: Array<{
			name: string
			status: string
			conclusion: string | null
		}> = []

		if (checksRes.ok) {
			const checksData = (await checksRes.json()) as {
				check_runs: Array<{
					name: string
					status: string
					conclusion: string | null
				}>
			}
			checkRuns = checksData.check_runs
		}

		const completed = checkRuns.filter(cr => cr.status === "completed").length
		const successful = checkRuns.filter(
			cr => cr.status === "completed" && cr.conclusion === "success",
		).length
		const failed = checkRuns.filter(
			cr =>
				cr.status === "completed" &&
				(cr.conclusion === "failure" ||
					cr.conclusion === "cancelled" ||
					cr.conclusion === "timed_out"),
		).length
		const pending = checkRuns.length - completed

		return c.json({
			state: pr.merged ? "merged" : pr.state,
			mergeable: pr.mergeable ?? false,
			checks: {
				total: checkRuns.length,
				completed,
				successful,
				pending,
				failed,
			},
			checkRuns: checkRuns.map(cr => ({
				name: cr.name,
				status: cr.status,
				conclusion: cr.conclusion,
			})),
		})
	},
)

// POST /repos/:owner/:repo/pulls/:number/close — Close PR and delete branch
githubRepos.post(
	"/repos/:owner/:repo/pulls/:number/close",
	zValidator("param", PullParamSchema),
	async c => {
		const db = createDbFromUrl(c.env.DATABASE_URL)
		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { owner, repo, number } = c.req.valid("param")

		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

		const headers = {
			...getGitHubHeaders(accessToken),
			"Content-Type": "application/json",
		}

		// Get PR to find branch name
		const prRes = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
			{ headers: getGitHubHeaders(accessToken) },
		)
		if (!prRes.ok)
			return c.json(
				{ error: `GitHub API error: ${prRes.status}` },
				prRes.status as 400,
			)

		const pr = (await prRes.json()) as { head: { ref: string } }

		// Close the PR
		await fetch(
			`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
			{
				method: "PATCH",
				headers,
				body: JSON.stringify({ state: "closed" }),
			},
		)

		// Delete the branch
		try {
			await fetch(
				`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${pr.head.ref}`,
				{ method: "DELETE", headers: getGitHubHeaders(accessToken) },
			)
		} catch {
			// Branch may already be deleted
		}

		if (c.env.POSTHOG_KEY) {
			const posthog = createPostHogClient(c.env.POSTHOG_KEY, c.env.POSTHOG_HOST)
			posthog.capture({
				distinctId: authRow.userId,
				event: "pr_closed",
				properties: {
					repo: `${owner}/${repo}`,
					pr_number: number,
				},
			})
		}

		return c.json({ success: true, closed: true })
	},
)

// POST /repos/:owner/:repo/pulls/:number/merge — Merge PR and delete branch
githubRepos.post(
	"/repos/:owner/:repo/pulls/:number/merge",
	zValidator("param", PullParamSchema),
	async c => {
		const db = createDbFromUrl(c.env.DATABASE_URL)
		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { owner, repo, number } = c.req.valid("param")

		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

		const headers = {
			...getGitHubHeaders(accessToken),
			"Content-Type": "application/json",
		}

		// Get PR to find branch name
		const prRes = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
			{ headers: getGitHubHeaders(accessToken) },
		)
		if (!prRes.ok)
			return c.json(
				{ error: `GitHub API error: ${prRes.status}` },
				prRes.status as 400,
			)

		const pr = (await prRes.json()) as { head: { ref: string } }

		// Merge the PR
		const mergeRes = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/merge`,
			{
				method: "PUT",
				headers,
				body: JSON.stringify({ merge_method: "squash" }),
			},
		)
		if (!mergeRes.ok) {
			const body = await mergeRes.text()
			return c.json(
				{ error: body || `Merge failed: ${mergeRes.status}` },
				mergeRes.status as 400,
			)
		}

		// Delete the branch
		try {
			await fetch(
				`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${pr.head.ref}`,
				{ method: "DELETE", headers: getGitHubHeaders(accessToken) },
			)
		} catch {
			// Branch may already be deleted
		}

		if (c.env.POSTHOG_KEY) {
			const posthog = createPostHogClient(c.env.POSTHOG_KEY, c.env.POSTHOG_HOST)
			posthog.capture({
				distinctId: authRow.userId,
				event: "pr_merged",
				properties: {
					repo: `${owner}/${repo}`,
					pr_number: number,
				},
			})
		}

		return c.json({ success: true, merged: true })
	},
)

// POST /repos/:owner/:repo/workflows/dispatch — Dispatch workflow
githubRepos.post(
	"/repos/:owner/:repo/workflows/dispatch",
	zValidator("param", RepoParamSchema),
	zValidator("json", DispatchRequestSchema),
	async c => {
		const db = createDbFromUrl(c.env.DATABASE_URL)
		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { owner, repo } = c.req.valid("param")
		const { prompt, baseBranch, ref, targetRepo, chatId: requestChatId } = c.req.valid("json")

		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

		const headers = {
			...getGitHubHeaders(accessToken),
			"Content-Type": "application/json",
		}

		const normalizedPrompt = prompt.trim()
		const inputs: Record<string, string> = {
			prompt: normalizedPrompt,
		}
		if (baseBranch && baseBranch !== "main") {
			inputs.base_branch = baseBranch
		}
		if (targetRepo) {
			inputs.target_repo = targetRepo
		}

		// Determine dispatch ref
		let dispatchRef = ref
		if (!dispatchRef) {
			const repoRes = await fetch(
				`https://api.github.com/repos/${owner}/${repo}`,
				{ headers: getGitHubHeaders(accessToken) },
			)
			if (repoRes.ok) {
				const repoData = (await repoRes.json()) as {
					default_branch: string
				}
				dispatchRef = repoData.default_branch
			} else {
				dispatchRef = "main"
			}
		}

		const dispatchedAt = Date.now()

		await fetch(
			`https://api.github.com/repos/${owner}/${repo}/actions/workflows/flamecast.yml/dispatches`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ ref: dispatchRef, inputs }),
			},
		)

		// Poll for the dispatched run ID
		let workflowRunId: number | null = null
		for (let attempt = 0; attempt < 12; attempt++) {
			const runsRes = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/actions/workflows/flamecast.yml/runs?event=workflow_dispatch&per_page=20`,
				{ headers: getGitHubHeaders(accessToken) },
			)

			if (runsRes.ok) {
				const data = (await runsRes.json()) as {
					workflow_runs: Array<{
						id: number
						created_at: string
					}>
				}
				const run = data.workflow_runs.find(
					candidate =>
						Date.parse(candidate.created_at) >= dispatchedAt - 30_000,
				)
				if (run) {
					workflowRunId = run.id
					break
				}
			}

			await sleep(1_000)
		}

		if (workflowRunId) {
			const [sourceRepoRow] = await db
				.insert(flamecastUserSourceRepos)
				.values({
					userId: authRow.userId,
					sourceRepo: `${owner}/${repo}`,
				})
				.onConflictDoUpdate({
					target: [
						flamecastUserSourceRepos.userId,
						flamecastUserSourceRepos.sourceRepo,
					],
					set: { createdAt: new Date() },
				})
				.returning({ id: flamecastUserSourceRepos.id })

			// Auto-create a chat if none provided
			const chatId = await getOrCreateChat(db, {
				chatId: requestChatId,
				userId: authRow.userId,
				title: normalizedPrompt,
				repo: targetRepo || `${owner}/${repo}`,
				sourceRepoId: sourceRepoRow.id,
			})

			await db
				.insert(flamecastWorkflowRuns)
				.values({
					workflowRunId,
					userId: authRow.userId,
					repo: targetRepo || `${owner}/${repo}`,
					sourceRepoId: sourceRepoRow.id,
					prompt: normalizedPrompt,
					chatId,
					createdAt: new Date(dispatchedAt),
				})
				.onConflictDoUpdate({
					target: [
						flamecastWorkflowRuns.workflowRunId,
						flamecastWorkflowRuns.userId,
					],
					set: {
						repo: targetRepo || `${owner}/${repo}`,
						sourceRepoId: sourceRepoRow.id,
						prompt: normalizedPrompt,
						chatId,
						createdAt: new Date(dispatchedAt),
					},
				})

			if (c.env.POSTHOG_KEY) {
				const posthog = createPostHogClient(
					c.env.POSTHOG_KEY,
					c.env.POSTHOG_HOST,
				)
				posthog.capture({
					distinctId: authRow.userId,
					event: "workflow_dispatch_completed",
					properties: {
						target_repo: targetRepo || `${owner}/${repo}`,
						source_repo: `${owner}/${repo}`,
						prompt_length: normalizedPrompt.length,
						workflow_run_id: workflowRunId,
					},
				})
			}
		}

		return c.json({ success: true })
	},
)

// GET /repos/:owner/:repo/workflows/runs — List workflow runs
githubRepos.get(
	"/repos/:owner/:repo/workflows/runs",
	zValidator("param", RepoParamSchema),
	async c => {
		const db = createDbFromUrl(c.env.DATABASE_URL)
		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { owner, repo } = c.req.valid("param")
		const branch = c.req.query("branch")

		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

		let url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/flamecast.yml/runs?per_page=5`
		if (branch) url += `&branch=${encodeURIComponent(branch)}`

		const res = await fetch(url, {
			headers: getGitHubHeaders(accessToken),
		})

		if (!res.ok)
			return c.json(
				{ error: `GitHub API error: ${res.status}` },
				res.status as 400,
			)

		const data = (await res.json()) as {
			workflow_runs: Array<{
				id: number
				head_branch: string | null
				status: string | null
				conclusion: string | null
				created_at: string
				html_url: string
			}>
		}

		const runs = data.workflow_runs.map(run => ({
			id: run.id,
			headBranch: run.head_branch,
			status: run.status,
			conclusion: run.conclusion,
			createdAt: run.created_at,
			url: run.html_url,
		}))

		return c.json(runs)
	},
)

// GET /repos/:owner/:repo/workflows/runs/:runId — Get run detail
githubRepos.get(
	"/repos/:owner/:repo/workflows/runs/:runId",
	zValidator("param", RunParamSchema),
	async c => {
		const db = createDbFromUrl(c.env.DATABASE_URL)
		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { owner, repo, runId } = c.req.valid("param")

		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

		const res = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
			{ headers: getGitHubHeaders(accessToken) },
		)

		if (!res.ok)
			return c.json(
				{ error: `GitHub API error: ${res.status}` },
				res.status as 400,
			)

		const data = (await res.json()) as {
			jobs: Array<{
				id: number
				status: string
				conclusion: string | null
				steps?: Array<{
					name: string
					status: string
					conclusion: string | null
					number: number
				}>
			}>
		}

		const jobs = data.jobs.map(job => ({
			id: job.id,
			status: job.status,
			conclusion: job.conclusion,
			steps:
				job.steps?.map(step => ({
					name: step.name,
					status: step.status,
					conclusion: step.conclusion,
					number: step.number,
				})) ?? [],
		}))

		return c.json({ jobs })
	},
)

// GET /repos/:owner/:repo/workflows/runs/:runId/logs — Get run logs URL
githubRepos.get(
	"/repos/:owner/:repo/workflows/runs/:runId/logs",
	zValidator("param", RunParamSchema),
	async c => {
		const db = createDbFromUrl(c.env.DATABASE_URL)
		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { owner, repo, runId } = c.req.valid("param")

		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

		const res = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`,
			{
				headers: getGitHubHeaders(accessToken),
				redirect: "manual",
			},
		)

		const location = res.headers.get("location")
		const downloadUrl = location || (res.ok ? res.url : null)

		return c.json({ downloadUrl })
	},
)

export default githubRepos
