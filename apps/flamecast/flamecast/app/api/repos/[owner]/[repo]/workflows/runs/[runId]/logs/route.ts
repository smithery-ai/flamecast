import { NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"

export async function GET(
	_request: Request,
	{
		params,
	}: { params: Promise<{ owner: string; repo: string; runId: string }> },
) {
	const creds = await getGitHubCredentials()
	if (!creds)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const { owner, repo, runId } = await params
	const octokit = createOctokit(creds.accessToken)

	const { url } = await octokit.rest.actions.downloadWorkflowRunLogs({
		owner,
		repo,
		run_id: Number(runId),
	})

	return NextResponse.json({ downloadUrl: url })
}
