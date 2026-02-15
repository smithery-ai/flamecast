import { type NextRequest, NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import { getDb } from "@/lib/db"
import { createOctokit } from "@/lib/github"
import { getPostHogClient } from "@/lib/posthog-server"
import {
	flamecastUserSourceRepos,
	flamecastWorkflowRuns,
} from "@smithery/flamecast-db/schema"

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
		prompt?: string
		baseBranch?: string
		ref?: string
		targetRepo?: string
		syncBase?: boolean
	}
	const { prompt, baseBranch, ref, targetRepo, syncBase } = body

	if (typeof prompt !== "string" || !prompt.trim()) {
		return NextResponse.json({ error: "prompt is required" }, { status: 400 })
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
	if (syncBase) {
		inputs.sync_base = "true"
	}

	const dispatchedAt = Date.now()
	const dispatchRef =
		ref ||
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
		const db = getDb()
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
				prompt: normalizedPrompt,
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
					createdAt: new Date(dispatchedAt),
				},
			})

		posthog.capture({
			distinctId: creds.userId,
			event: "workflow_dispatch_completed",
			properties: {
				target_repo: targetRepo || `${owner}/${repo}`,
				source_repo: `${owner}/${repo}`,
				prompt_length: normalizedPrompt.length,
				workflow_run_id: workflowRunId,
			},
		})
	}

	return NextResponse.json({ success: true })
}
