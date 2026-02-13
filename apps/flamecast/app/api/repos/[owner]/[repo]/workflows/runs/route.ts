import { type NextRequest, NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ owner: string; repo: string }> },
) {
	const creds = await getGitHubCredentials()
	if (!creds)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const { owner, repo } = await params
	const octokit = createOctokit(creds.accessToken)
	const branch = request.nextUrl.searchParams.get("branch")

	const { data } = await octokit.rest.actions.listWorkflowRuns({
		owner,
		repo,
		workflow_id: "flamecast.yml",
		per_page: 5,
		...(branch ? { branch } : {}),
	})

	const runs = data.workflow_runs.map(run => ({
		id: run.id,
		headBranch: run.head_branch,
		status: run.status,
		conclusion: run.conclusion,
		createdAt: run.created_at,
		url: run.html_url,
	}))

	return NextResponse.json(runs)
}
