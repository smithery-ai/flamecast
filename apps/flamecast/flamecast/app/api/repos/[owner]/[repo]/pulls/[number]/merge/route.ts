import { NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"
import { getPostHogClient } from "@/lib/posthog-server"

export async function POST(
	_request: Request,
	{
		params,
	}: { params: Promise<{ owner: string; repo: string; number: string }> },
) {
	const creds = await getGitHubCredentials()
	if (!creds)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const { owner, repo, number } = await params
	const prNumber = Number(number)
	const octokit = createOctokit(creds.accessToken)

	const { data: pr } = await octokit.rest.pulls.get({
		owner,
		repo,
		pull_number: prNumber,
	})

	await octokit.rest.pulls.merge({
		owner,
		repo,
		pull_number: prNumber,
		merge_method: "squash",
	})

	try {
		await octokit.rest.git.deleteRef({
			owner,
			repo,
			ref: `heads/${pr.head.ref}`,
		})
	} catch {
		// Branch may already be deleted
	}

	const posthog = getPostHogClient()
	posthog.capture({
		distinctId: creds.userId,
		event: "pr_merged",
		properties: {
			repo: `${owner}/${repo}`,
			pr_number: prNumber,
		},
	})

	return NextResponse.json({ success: true, merged: true })
}
