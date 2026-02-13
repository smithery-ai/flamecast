import { NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import {
	FLAMECAST_WORKFLOW_CONTENT,
	FLAMECAST_WORKFLOW_PATH,
	getFlamecastWorkflowContentBase64,
} from "@/lib/flamecast-workflow"
import { createOctokit } from "@/lib/github"

function hasStatusCode(error: unknown): error is { status: number } {
	if (typeof error !== "object" || error === null) return false
	if (!("status" in error)) return false
	return typeof error.status === "number"
}

export async function POST() {
	const creds = await getGitHubCredentials()
	if (!creds)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const octokit = createOctokit(creds.accessToken)
	const { data: ghUser } = await octokit.rest.users.getAuthenticated()
	const username = ghUser.login

	let defaultBranch = "main"
	try {
		const { data: repo } = await octokit.rest.repos.get({
			owner: username,
			repo: "flamecast",
		})
		defaultBranch = repo.default_branch
	} catch (error) {
		if (hasStatusCode(error) && error.status === 404) {
			return NextResponse.json(
				{ error: "Repository not found. Create it first." },
				{ status: 404 },
			)
		}
		throw error
	}

	let workflowSha: string | undefined
	try {
		const { data: existingWorkflow } = await octokit.rest.repos.getContent({
			owner: username,
			repo: "flamecast",
			path: FLAMECAST_WORKFLOW_PATH,
			ref: defaultBranch,
		})

		if (Array.isArray(existingWorkflow) || existingWorkflow.type !== "file") {
			return NextResponse.json(
				{ error: "Workflow path exists but is not a file." },
				{ status: 409 },
			)
		}

		workflowSha = existingWorkflow.sha
		const existingContent = Buffer.from(
			existingWorkflow.content,
			"base64",
		).toString("utf8")
		if (existingContent === FLAMECAST_WORKFLOW_CONTENT) {
			return NextResponse.json(
				{ error: "Workflow is already up to date." },
				{ status: 409 },
			)
		}
	} catch (error) {
		if (!(hasStatusCode(error) && error.status === 404)) throw error
	}

	const { data: baseRef } = await octokit.rest.git.getRef({
		owner: username,
		repo: "flamecast",
		ref: `heads/${defaultBranch}`,
	})

	const branchName = `flamecast/${username}/workflow-reset-${Date.now()}`
	await octokit.rest.git.createRef({
		owner: username,
		repo: "flamecast",
		ref: `refs/heads/${branchName}`,
		sha: baseRef.object.sha,
	})

	await octokit.rest.repos.createOrUpdateFileContents({
		owner: username,
		repo: "flamecast",
		path: FLAMECAST_WORKFLOW_PATH,
		message: "chore: reset flamecast workflow",
		content: getFlamecastWorkflowContentBase64(),
		branch: branchName,
		...(workflowSha ? { sha: workflowSha } : {}),
	})

	const { data: pull } = await octokit.rest.pulls.create({
		owner: username,
		repo: "flamecast",
		title: "chore: reset flamecast workflow",
		head: branchName,
		base: defaultBranch,
		body: "Reset `.github/workflows/flamecast.yml` to the latest Flamecast workflow.",
	})

	return NextResponse.json({
		success: true,
		branchName,
		prNumber: pull.number,
		prUrl: pull.html_url,
	})
}
