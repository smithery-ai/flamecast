import { type NextRequest, NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import { getDb } from "@/lib/db"
import { createOctokit } from "@/lib/github"
import { getPostHogClient } from "@/lib/posthog-server"
import {
	flamecastUserSourceRepos,
	flamecastWorkflowRuns,
} from "@smithery/flamecast-db/schema"
import { eq, and } from "drizzle-orm"

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function findDispatchedRunId(
	octokit: ReturnType<typeof createOctokit>,
	{
		owner,
		repo,
		dispatchedAt,
	}: { owner: string; repo: string; dispatchedAt: number },
) {
	for (let attempt = 0; attempt < 12; attempt++) {
		const { data } = await octokit.rest.actions.listWorkflowRuns({
			owner,
			repo,
			workflow_id: "flamecast.yml",
			event: "workflow_dispatch",
			per_page: 20,
		})

		const run = data.workflow_runs.find(candidate => {
			return Date.parse(candidate.created_at) >= dispatchedAt - 30_000
		})
		if (run) return run.id

		await sleep(1_000)
	}

	return null
}

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ owner: string; repo: string }> },
) {
	const creds = await getGitHubCredentials()
	if (!creds)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const { owner, repo } = await params
	const octokit = createOctokit(creds.accessToken)
	const body = (await request.json()) as {
		parentRunId?: number
		followupPrompt?: string
		targetRepo?: string
	}
	const { parentRunId, followupPrompt, targetRepo } = body

	if (typeof parentRunId !== "number" || parentRunId <= 0) {
		return NextResponse.json(
			{ error: "parentRunId is required and must be a positive number" },
			{ status: 400 },
		)
	}

	if (typeof followupPrompt !== "string" || !followupPrompt.trim()) {
		return NextResponse.json(
			{ error: "followupPrompt is required" },
			{ status: 400 },
		)
	}

	const normalizedFollowup = followupPrompt.trim()

	// Fetch parent workflow run data
	const db = getDb()
	const [parentRun] = await db
		.select()
		.from(flamecastWorkflowRuns)
		.where(
			and(
				eq(flamecastWorkflowRuns.workflowRunId, parentRunId),
				eq(flamecastWorkflowRuns.userId, creds.userId),
			),
		)
		.limit(1)

	if (!parentRun) {
		return NextResponse.json(
			{ error: "Parent workflow run not found" },
			{ status: 404 },
		)
	}

	// Fetch parent workflow run outputs to get Claude logs and branch name
	try {
		const outputsResponse = await fetch(
			`${process.env.NEXT_PUBLIC_BACKEND_URL}/runs/${owner}/${repo}/${parentRunId}/outputs`,
			{
				headers: {
					Authorization: `Bearer ${creds.accessToken}`,
				},
			},
		)

		if (!outputsResponse.ok) {
			return NextResponse.json(
				{ error: "Failed to fetch parent workflow outputs" },
				{ status: 500 },
			)
		}

		const outputs = (await outputsResponse.json()) as {
			available: boolean
			prompt: string | null
			claudeLogs: string | null
			branchName: string | null
		}

		// Construct combined prompt with context
		const originalPrompt = outputs.prompt || parentRun.prompt || "N/A"
		const claudeOutput = outputs.claudeLogs || "No Claude logs available"

		// Truncate Claude logs if too long (to avoid hitting GitHub API limits)
		const maxLogsLength = 5000
		const truncatedLogs =
			claudeOutput.length > maxLogsLength
				? claudeOutput.substring(0, maxLogsLength) +
					"\n\n... (truncated for brevity)"
				: claudeOutput

		const combinedPrompt = `This is a follow-up to a previous workflow run.

Original prompt:
${originalPrompt}

Claude's output from the previous run:
${truncatedLogs}

Follow-up request:
${normalizedFollowup}`

		// Determine base branch - use PR branch if available
		let baseBranch: string | undefined
		if (outputs.branchName) {
			baseBranch = outputs.branchName
		}

		const inputs: Record<string, string> = {
			prompt: combinedPrompt,
		}
		if (baseBranch) {
			inputs.base_branch = baseBranch
		}
		if (targetRepo) {
			inputs.target_repo = targetRepo
		}

		const dispatchedAt = Date.now()
		const dispatchRef =
			(
				await octokit.rest.repos.get({
					owner,
					repo,
				})
			).data.default_branch

		await octokit.rest.actions.createWorkflowDispatch({
			owner,
			repo,
			workflow_id: "flamecast.yml",
			ref: dispatchRef,
			inputs,
		})

		const workflowRunId = await findDispatchedRunId(octokit, {
			owner,
			repo,
			dispatchedAt,
		})

		const posthog = getPostHogClient()

		if (workflowRunId) {
			const [sourceRepoRow] = await db
				.insert(flamecastUserSourceRepos)
				.values({
					userId: creds.userId,
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

			await db
				.insert(flamecastWorkflowRuns)
				.values({
					workflowRunId,
					userId: creds.userId,
					repo: targetRepo || `${owner}/${repo}`,
					sourceRepoId: sourceRepoRow.id,
					prompt: combinedPrompt,
					parentWorkflowRunId: parentRunId,
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
						prompt: combinedPrompt,
						parentWorkflowRunId: parentRunId,
						createdAt: new Date(dispatchedAt),
					},
				})

			posthog.capture({
				distinctId: creds.userId,
				event: "workflow_followup_dispatched",
				properties: {
					target_repo: targetRepo || `${owner}/${repo}`,
					source_repo: `${owner}/${repo}`,
					parent_run_id: parentRunId,
					followup_length: normalizedFollowup.length,
					workflow_run_id: workflowRunId,
					has_base_branch: !!baseBranch,
				},
			})
		}

		return NextResponse.json({ success: true })
	} catch (error) {
		console.error("Error dispatching follow-up workflow:", error)
		return NextResponse.json(
			{ error: "Failed to dispatch follow-up workflow" },
			{ status: 500 },
		)
	}
}
