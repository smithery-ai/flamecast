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
	const user = request.nextUrl.searchParams.get("user")

	const prefix = user ? `flamecast/${user}/` : "flamecast/"

	const { data: pulls } = await octokit.rest.pulls.list({
		owner,
		repo,
		state: "open",
		per_page: 100,
	})

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

	return NextResponse.json(flamecastPRs)
}
