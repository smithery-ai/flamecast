import { NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"

export async function GET(
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

	const { data: checksData } = await octokit.rest.checks.listForRef({
		owner,
		repo,
		ref: pr.head.sha,
		per_page: 100,
	})

	const checkRuns = checksData.check_runs
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

	return NextResponse.json({
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
}
