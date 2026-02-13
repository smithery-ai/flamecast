import { NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"
import { getDb } from "@/lib/db"
import { flamecastApiKeys } from "@smithery/db-ps/schema"
import { eq } from "drizzle-orm"
import sodium from "libsodium-wrappers"
import {
	FLAMECAST_WORKFLOW_CONTENT,
	FLAMECAST_WORKFLOW_PATH,
	getFlamecastWorkflowContentBase64,
} from "@/lib/flamecast-workflow"

function hasStatusCode(error: unknown): error is { status: number } {
	if (typeof error !== "object" || error === null) return false
	if (!("status" in error)) return false
	return typeof error.status === "number"
}

export async function POST() {
	const creds = await getGitHubCredentials()
	if (!creds)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const db = getDb()
	const octokit = createOctokit(creds.accessToken)
	const { data: ghUser } = await octokit.rest.users.getAuthenticated()
	const username = ghUser.login

	// 1. Get or create an API key for this user
	let [apiKeyRow] = await db
		.select({ id: flamecastApiKeys.id, key: flamecastApiKeys.key })
		.from(flamecastApiKeys)
		.where(eq(flamecastApiKeys.userId, creds.userId))
		.limit(1)

	if (!apiKeyRow) {
		;[apiKeyRow] = await db
			.insert(flamecastApiKeys)
			.values({
				userId: creds.userId,
				name: "Workflow API Key",
				description: "Auto-created for workflow status tracking",
			})
			.returning({ id: flamecastApiKeys.id, key: flamecastApiKeys.key })
	}

	// 2. Save API key as FLAMECAST_API_KEY GitHub secret
	const { data: publicKey } = await octokit.rest.actions.getRepoPublicKey({
		owner: username,
		repo: "flamecast",
	})

	await sodium.ready
	const binKey = sodium.from_base64(
		publicKey.key,
		sodium.base64_variants.ORIGINAL,
	)
	const binSecret = sodium.from_string(apiKeyRow.key)
	const encrypted = sodium.crypto_box_seal(binSecret, binKey)
	const encryptedBase64 = sodium.to_base64(
		encrypted,
		sodium.base64_variants.ORIGINAL,
	)

	await octokit.rest.actions.createOrUpdateRepoSecret({
		owner: username,
		repo: "flamecast",
		secret_name: "FLAMECAST_API_KEY",
		encrypted_value: encryptedBase64,
		key_id: publicKey.key_id,
	})

	// 3. Create PR with updated workflow
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

	const branchName = `flamecast/${username}/workflow-update-${Date.now()}`
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
		message: "chore: update flamecast workflow with status tracking",
		content: getFlamecastWorkflowContentBase64(),
		branch: branchName,
		...(workflowSha ? { sha: workflowSha } : {}),
	})

	const { data: pull } = await octokit.rest.pulls.create({
		owner: username,
		repo: "flamecast",
		title: "chore: update flamecast workflow with status tracking",
		head: branchName,
		base: defaultBranch,
		body: "Updates `.github/workflows/flamecast.yml` to include workflow status tracking.\n\nAlso sets `FLAMECAST_API_KEY` as a repository secret.",
	})

	return NextResponse.json({
		success: true,
		branchName,
		prNumber: pull.number,
		prUrl: pull.html_url,
	})
}
