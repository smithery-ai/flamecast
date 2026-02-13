import { type NextRequest, NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"
import { getPostHogClient } from "@/lib/posthog-server"
import { getUserApiKey } from "@/lib/api-key-auth"

const BACKEND_URL =
	process.env.NEXT_PUBLIC_BACKEND_URL || "https://api.flamecast.dev"

async function getWorkflowRunMetadata(
	apiKey: string,
	runId: string,
): Promise<{ prompt: string | null; repo: string | null; sourceRepo: string | null } | null> {
	const url = new URL("/workflow-runs/metadata", BACKEND_URL)
	url.searchParams.set("runId", runId)

	const res = await fetch(url.toString(), {
		headers: { Authorization: `Bearer ${apiKey}` },
		cache: "no-store",
	})

	if (!res.ok) return null

	return res.json()
}

export async function POST(
	_request: NextRequest,
	{
		params,
	}: {
		params: Promise<{ owner: string; repo: string; runId: string }>
	},
) {
	const creds = await getGitHubCredentials()
	if (!creds)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const { owner, repo, runId } = await params

	// Get the API key to fetch metadata
	const apiKey = await getUserApiKey(creds.userId)
	if (!apiKey) {
		return NextResponse.json({ error: "No API key found" }, { status: 403 })
	}

	// Fetch the original prompt and repo from the workflow run
	const metadata = await getWorkflowRunMetadata(apiKey, runId)
	if (!metadata || !metadata.prompt) {
		return NextResponse.json(
			{ error: "Could not retrieve workflow run metadata" },
			{ status: 404 },
		)
	}

	const { prompt, repo: targetRepo, sourceRepo } = metadata

	// Verify the source repo matches the request
	if (sourceRepo !== `${owner}/${repo}`) {
		return NextResponse.json(
			{ error: "Source repo mismatch" },
			{ status: 400 },
		)
	}

	const octokit = createOctokit(creds.accessToken)

	// Dispatch a new workflow run with the same prompt but on a different branch
	// The workflow will automatically create a new branch
	const dispatchRef =
		(
			await octokit.rest.repos.get({
				owner,
				repo,
			})
		).data.default_branch

	const inputs: Record<string, string> = {
		prompt,
	}
	if (targetRepo) {
		inputs.target_repo = targetRepo
	}

	await octokit.rest.actions.createWorkflowDispatch({
		owner,
		repo,
		workflow_id: "flamecast.yml",
		ref: dispatchRef,
		inputs,
	})

	const posthog = getPostHogClient()
	posthog.capture({
		distinctId: creds.userId,
		event: "workflow_retry",
		properties: {
			original_run_id: runId,
			target_repo: targetRepo || `${owner}/${repo}`,
			source_repo: `${owner}/${repo}`,
			prompt_length: prompt.length,
		},
	})

	return NextResponse.json({ success: true })
}
