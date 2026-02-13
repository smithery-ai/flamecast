import { NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import {
	FLAMECAST_WORKFLOW_PATH,
	getFlamecastWorkflowContentBase64,
} from "@/lib/flamecast-workflow"
import { createOctokit } from "@/lib/github"
import { getPostHogClient } from "@/lib/posthog-server"

export async function POST() {
	const creds = await getGitHubCredentials()
	if (!creds)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const octokit = createOctokit(creds.accessToken)
	const { data: ghUser } = await octokit.rest.users.getAuthenticated()
	const username = ghUser.login

	// Check if repo already exists
	try {
		await octokit.rest.repos.get({ owner: username, repo: "flamecast" })
		return NextResponse.json(
			{ error: "Repository already exists" },
			{ status: 409 },
		)
	} catch {
		// Repo doesn't exist, proceed to create
	}

	const content = getFlamecastWorkflowContentBase64()

	// Create the repo
	await octokit.rest.repos.createForAuthenticatedUser({
		name: "flamecast",
		description: "Flamecast workflow repository",
		private: false,
		auto_init: true,
	})

	// Add the workflow file
	await octokit.rest.repos.createOrUpdateFileContents({
		owner: username,
		repo: "flamecast",
		path: FLAMECAST_WORKFLOW_PATH,
		message: "Add flamecast workflow",
		content,
	})

	const posthog = getPostHogClient()
	posthog.capture({
		distinctId: creds.userId,
		event: "repo_created",
		properties: {
			repo: `${username}/flamecast`,
		},
	})

	return NextResponse.json({ created: true, repo: `${username}/flamecast` })
}
