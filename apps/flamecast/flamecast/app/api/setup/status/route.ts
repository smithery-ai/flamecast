import { NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"

export async function GET() {
	const creds = await getGitHubCredentials()
	if (!creds)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const octokit = createOctokit(creds.accessToken)
	const { data: ghUser } = await octokit.rest.users.getAuthenticated()
	const username = ghUser.login

	let repoExists = false
	try {
		await octokit.rest.repos.get({ owner: username, repo: "flamecast" })
		repoExists = true
	} catch {
		repoExists = false
	}

	let hasClaudeToken = false
	let hasFlamecastPat = false
	let hasFlamecastApiKey = false

	if (repoExists) {
		try {
			await octokit.rest.actions.getRepoSecret({
				owner: username,
				repo: "flamecast",
				secret_name: "CLAUDE_CODE_OAUTH_TOKEN",
			})
			hasClaudeToken = true
		} catch {
			hasClaudeToken = false
		}

		try {
			await octokit.rest.actions.getRepoSecret({
				owner: username,
				repo: "flamecast",
				secret_name: "FLAMECAST_PAT",
			})
			hasFlamecastPat = true
		} catch {
			hasFlamecastPat = false
		}

		try {
			await octokit.rest.actions.getRepoSecret({
				owner: username,
				repo: "flamecast",
				secret_name: "FLAMECAST_API_KEY",
			})
			hasFlamecastApiKey = true
		} catch {
			hasFlamecastApiKey = false
		}
	}

	return NextResponse.json({
		username,
		repoExists,
		hasClaudeToken,
		hasFlamecastPat,
		hasFlamecastApiKey,
	})
}
