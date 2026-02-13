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

	const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
		owner,
		repo,
		run_id: Number(runId),
	})

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

	return NextResponse.json({ jobs })
}
