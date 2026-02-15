import { Hono } from "hono"
import { z } from "zod"
import { eq } from "drizzle-orm"
import { validator as zValidator } from "hono-openapi"
import { flamecastApiKeys } from "@smithery/flamecast-db/schema"
import {
	FLAMECAST_WORKFLOW_CONTENT,
	FLAMECAST_WORKFLOW_PATH,
	getFlamecastWorkflowContentBase64,
} from "@smithery/flamecast/flamecast-workflow"
import { createDbFromUrl } from "../lib/db"
import {
	authenticateApiKey,
	getGitHubAccessToken,
	getGitHubHeaders,
} from "../lib/auth"
import { createPostHogClient } from "../lib/posthog"
import type { Bindings } from "../index"

const setup = new Hono<{ Bindings: Bindings }>()

const SaveSecretsRequestSchema = z.object({
	repo: z.string().min(1),
	secrets: z.record(z.string(), z.string()),
})

function hasStatusCode(error: unknown): error is { status: number } {
	if (typeof error !== "object" || error === null) return false
	if (!("status" in error)) return false
	return typeof error.status === "number"
}

function encryptSecret(value: string, publicKeyBase64: string): string {
	const nacl = require("tweetnacl") as typeof import("tweetnacl")
	const blake2b = require("blakejs").blake2b as typeof import("blakejs").blake2b

	const recipientPk = Buffer.from(publicKeyBase64, "base64")
	const message = Buffer.from(value, "utf8")

	// Generate ephemeral keypair
	const ephemeralKp = nacl.box.keyPair()

	// Compute nonce: blake2b(ephemeral_pk || recipient_pk, null, 24)
	const nonceInput = Buffer.concat([
		Buffer.from(ephemeralKp.publicKey),
		recipientPk,
	])
	const nonce = blake2b(nonceInput, undefined, 24)

	// Encrypt: crypto_box(message, nonce, ephemeral_sk, recipient_pk)
	const encrypted = nacl.box(
		message,
		nonce,
		new Uint8Array(recipientPk),
		ephemeralKp.secretKey,
	)
	if (!encrypted) throw new Error("Encryption failed")

	// Sealed box = ephemeral_pk || encrypted
	const sealed = Buffer.concat([
		Buffer.from(ephemeralKp.publicKey),
		Buffer.from(encrypted),
	])
	return sealed.toString("base64")
}

// GET /status — Check setup completion status
setup.get("/status", async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)

	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const accessToken = await getGitHubAccessToken(db, authRow.userId)
	if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

	const headers = getGitHubHeaders(accessToken)

	// Get authenticated user
	const userRes = await fetch("https://api.github.com/user", { headers })
	if (!userRes.ok) return c.json({ error: "Failed to get GitHub user" }, 500)
	const ghUser = (await userRes.json()) as { login: string }
	const username = ghUser.login

	// Check repo exists
	let repoExists = false
	const repoRes = await fetch(
		`https://api.github.com/repos/${username}/flamecast`,
		{ headers },
	)
	repoExists = repoRes.ok

	let hasClaudeToken = false
	let hasFlamecastPat = false
	let hasFlamecastApiKey = false

	if (repoExists) {
		const secretChecks = await Promise.allSettled([
			fetch(
				`https://api.github.com/repos/${username}/flamecast/actions/secrets/CLAUDE_CODE_OAUTH_TOKEN`,
				{ headers },
			),
			fetch(
				`https://api.github.com/repos/${username}/flamecast/actions/secrets/FLAMECAST_PAT`,
				{ headers },
			),
			fetch(
				`https://api.github.com/repos/${username}/flamecast/actions/secrets/FLAMECAST_API_KEY`,
				{ headers },
			),
		])

		hasClaudeToken =
			secretChecks[0].status === "fulfilled" && secretChecks[0].value.ok
		hasFlamecastPat =
			secretChecks[1].status === "fulfilled" && secretChecks[1].value.ok
		hasFlamecastApiKey =
			secretChecks[2].status === "fulfilled" && secretChecks[2].value.ok
	}

	return c.json({
		username,
		repoExists,
		hasClaudeToken,
		hasFlamecastPat,
		hasFlamecastApiKey,
	})
})

// POST /repo — Create flamecast repo
setup.post("/repo", async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)

	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const accessToken = await getGitHubAccessToken(db, authRow.userId)
	if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

	const headers = {
		...getGitHubHeaders(accessToken),
		"Content-Type": "application/json",
	}

	// Get username
	const userRes = await fetch("https://api.github.com/user", {
		headers: getGitHubHeaders(accessToken),
	})
	if (!userRes.ok) return c.json({ error: "Failed to get GitHub user" }, 500)
	const ghUser = (await userRes.json()) as { login: string }
	const username = ghUser.login

	// Check if repo already exists
	const checkRes = await fetch(
		`https://api.github.com/repos/${username}/flamecast`,
		{ headers: getGitHubHeaders(accessToken) },
	)
	if (checkRes.ok) return c.json({ error: "Repository already exists" }, 409)

	const content = getFlamecastWorkflowContentBase64()

	// Create the repo
	await fetch("https://api.github.com/user/repos", {
		method: "POST",
		headers,
		body: JSON.stringify({
			name: "flamecast",
			description: "Flamecast workflow repository",
			private: false,
			auto_init: true,
		}),
	})

	// Add the workflow file
	await fetch(
		`https://api.github.com/repos/${username}/flamecast/contents/${FLAMECAST_WORKFLOW_PATH}`,
		{
			method: "PUT",
			headers,
			body: JSON.stringify({
				message: "Add flamecast workflow",
				content,
			}),
		},
	)

	if (c.env.POSTHOG_KEY) {
		const posthog = createPostHogClient(c.env.POSTHOG_KEY, c.env.POSTHOG_HOST)
		posthog.capture({
			distinctId: authRow.userId,
			event: "repo_created",
			properties: { repo: `${username}/flamecast` },
		})
	}

	return c.json({ created: true, repo: `${username}/flamecast` })
})

// POST /secrets — Save secrets to GitHub repo
setup.post(
	"/secrets",
	zValidator("json", SaveSecretsRequestSchema),
	async c => {
		const db = createDbFromUrl(c.env.DATABASE_URL)

		const authRow = await authenticateApiKey(db, c.req.header("authorization"))
		if (!authRow) return c.json({ error: "Unauthorized" }, 401)

		const { repo, secrets } = c.req.valid("json")
		const [owner, name] = repo.split("/")
		if (!owner || !name) return c.json({ error: "Invalid repo format" }, 400)

		const accessToken = await getGitHubAccessToken(db, authRow.userId)
		if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

		const headers = {
			...getGitHubHeaders(accessToken),
			"Content-Type": "application/json",
		}

		// Get the repo's public key for encrypting secrets
		const pkRes = await fetch(
			`https://api.github.com/repos/${owner}/${name}/actions/secrets/public-key`,
			{ headers: getGitHubHeaders(accessToken) },
		)
		if (!pkRes.ok)
			return c.json({ error: "Failed to get repo public key" }, 500)
		const publicKey = (await pkRes.json()) as {
			key: string
			key_id: string
		}

		for (const [secretName, secretValue] of Object.entries(secrets)) {
			if (!secretValue) continue

			const encryptedBase64 = await encryptSecret(secretValue, publicKey.key)

			await fetch(
				`https://api.github.com/repos/${owner}/${name}/actions/secrets/${secretName}`,
				{
					method: "PUT",
					headers,
					body: JSON.stringify({
						encrypted_value: encryptedBase64,
						key_id: publicKey.key_id,
					}),
				},
			)
		}

		return c.json({ success: true })
	},
)

// POST /workflow/reset — Reset workflow via PR
setup.post("/workflow/reset", async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)

	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const accessToken = await getGitHubAccessToken(db, authRow.userId)
	if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

	const headers = {
		...getGitHubHeaders(accessToken),
		"Content-Type": "application/json",
	}
	const readHeaders = getGitHubHeaders(accessToken)

	// Get username
	const userRes = await fetch("https://api.github.com/user", {
		headers: readHeaders,
	})
	if (!userRes.ok) return c.json({ error: "Failed to get GitHub user" }, 500)
	const ghUser = (await userRes.json()) as { login: string }
	const username = ghUser.login

	// Get repo default branch
	const repoRes = await fetch(
		`https://api.github.com/repos/${username}/flamecast`,
		{ headers: readHeaders },
	)
	if (!repoRes.ok)
		return c.json({ error: "Repository not found. Create it first." }, 404)

	const repoData = (await repoRes.json()) as { default_branch: string }
	const defaultBranch = repoData.default_branch

	// Check existing workflow
	let workflowSha: string | undefined
	const workflowRes = await fetch(
		`https://api.github.com/repos/${username}/flamecast/contents/${FLAMECAST_WORKFLOW_PATH}?ref=${defaultBranch}`,
		{ headers: readHeaders },
	)

	if (workflowRes.ok) {
		const workflowData = (await workflowRes.json()) as {
			type: string
			sha: string
			content: string
		}
		if (workflowData.type !== "file")
			return c.json({ error: "Workflow path exists but is not a file." }, 409)

		workflowSha = workflowData.sha
		const existingContent = Buffer.from(
			workflowData.content,
			"base64",
		).toString("utf8")
		if (existingContent === FLAMECAST_WORKFLOW_CONTENT)
			return c.json({ error: "Workflow is already up to date." }, 409)
	} else if (workflowRes.status !== 404) {
		return c.json({ error: "Failed to check workflow file" }, 500)
	}

	// Get base ref
	const baseRefRes = await fetch(
		`https://api.github.com/repos/${username}/flamecast/git/ref/heads/${defaultBranch}`,
		{ headers: readHeaders },
	)
	if (!baseRefRes.ok) return c.json({ error: "Failed to get base ref" }, 500)
	const baseRefData = (await baseRefRes.json()) as {
		object: { sha: string }
	}

	// Create branch
	const branchName = `flamecast/${username}/workflow-reset-${Date.now()}`
	await fetch(`https://api.github.com/repos/${username}/flamecast/git/refs`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			ref: `refs/heads/${branchName}`,
			sha: baseRefData.object.sha,
		}),
	})

	// Update workflow file
	await fetch(
		`https://api.github.com/repos/${username}/flamecast/contents/${FLAMECAST_WORKFLOW_PATH}`,
		{
			method: "PUT",
			headers,
			body: JSON.stringify({
				message: "chore: reset flamecast workflow",
				content: getFlamecastWorkflowContentBase64(),
				branch: branchName,
				...(workflowSha ? { sha: workflowSha } : {}),
			}),
		},
	)

	// Create PR
	const prRes = await fetch(
		`https://api.github.com/repos/${username}/flamecast/pulls`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				title: "chore: reset flamecast workflow",
				head: branchName,
				base: defaultBranch,
				body: "Reset `.github/workflows/flamecast.yml` to the latest Flamecast workflow.",
			}),
		},
	)

	if (!prRes.ok) {
		const body = await prRes.text()
		return c.json({ error: body || "Failed to create PR" }, prRes.status as 400)
	}

	const pull = (await prRes.json()) as {
		number: number
		html_url: string
	}

	return c.json({
		success: true,
		branchName,
		prNumber: pull.number,
		prUrl: pull.html_url,
	})
})

// POST /workflow/update — Update workflow with status tracking
setup.post("/workflow/update", async c => {
	const db = createDbFromUrl(c.env.DATABASE_URL)

	const authRow = await authenticateApiKey(db, c.req.header("authorization"))
	if (!authRow) return c.json({ error: "Unauthorized" }, 401)

	const accessToken = await getGitHubAccessToken(db, authRow.userId)
	if (!accessToken) return c.json({ error: "GitHub token not found" }, 403)

	const headers = {
		...getGitHubHeaders(accessToken),
		"Content-Type": "application/json",
	}
	const readHeaders = getGitHubHeaders(accessToken)

	// Get username
	const userRes = await fetch("https://api.github.com/user", {
		headers: readHeaders,
	})
	if (!userRes.ok) return c.json({ error: "Failed to get GitHub user" }, 500)
	const ghUser = (await userRes.json()) as { login: string }
	const username = ghUser.login

	// 1. Get or create an API key for this user
	let [apiKeyRow] = await db
		.select({ id: flamecastApiKeys.id, key: flamecastApiKeys.key })
		.from(flamecastApiKeys)
		.where(eq(flamecastApiKeys.userId, authRow.userId))
		.limit(1)

	if (!apiKeyRow) {
		;[apiKeyRow] = await db
			.insert(flamecastApiKeys)
			.values({
				userId: authRow.userId,
				name: "Workflow API Key",
				description: "Auto-created for workflow status tracking",
			})
			.returning({ id: flamecastApiKeys.id, key: flamecastApiKeys.key })
	}

	// 2. Save API key as FLAMECAST_API_KEY GitHub secret
	const pkRes = await fetch(
		`https://api.github.com/repos/${username}/flamecast/actions/secrets/public-key`,
		{ headers: readHeaders },
	)
	if (!pkRes.ok) return c.json({ error: "Failed to get repo public key" }, 500)
	const publicKey = (await pkRes.json()) as {
		key: string
		key_id: string
	}

	const encryptedBase64 = await encryptSecret(apiKeyRow.key, publicKey.key)

	await fetch(
		`https://api.github.com/repos/${username}/flamecast/actions/secrets/FLAMECAST_API_KEY`,
		{
			method: "PUT",
			headers,
			body: JSON.stringify({
				encrypted_value: encryptedBase64,
				key_id: publicKey.key_id,
			}),
		},
	)

	// 3. Create PR with updated workflow
	const repoRes = await fetch(
		`https://api.github.com/repos/${username}/flamecast`,
		{ headers: readHeaders },
	)
	if (!repoRes.ok)
		return c.json({ error: "Repository not found. Create it first." }, 404)

	const repoData = (await repoRes.json()) as { default_branch: string }
	const defaultBranch = repoData.default_branch

	// Check existing workflow
	let workflowSha: string | undefined
	const workflowRes = await fetch(
		`https://api.github.com/repos/${username}/flamecast/contents/${FLAMECAST_WORKFLOW_PATH}?ref=${defaultBranch}`,
		{ headers: readHeaders },
	)

	if (workflowRes.ok) {
		const workflowData = (await workflowRes.json()) as {
			type: string
			sha: string
			content: string
		}
		if (workflowData.type !== "file")
			return c.json({ error: "Workflow path exists but is not a file." }, 409)

		workflowSha = workflowData.sha
		const existingContent = Buffer.from(
			workflowData.content,
			"base64",
		).toString("utf8")
		if (existingContent === FLAMECAST_WORKFLOW_CONTENT)
			return c.json({ error: "Workflow is already up to date." }, 409)
	} else if (workflowRes.status !== 404) {
		return c.json({ error: "Failed to check workflow file" }, 500)
	}

	// Get base ref
	const baseRefRes = await fetch(
		`https://api.github.com/repos/${username}/flamecast/git/ref/heads/${defaultBranch}`,
		{ headers: readHeaders },
	)
	if (!baseRefRes.ok) return c.json({ error: "Failed to get base ref" }, 500)
	const baseRefData = (await baseRefRes.json()) as {
		object: { sha: string }
	}

	// Create branch
	const branchName = `flamecast/${username}/workflow-update-${Date.now()}`
	await fetch(`https://api.github.com/repos/${username}/flamecast/git/refs`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			ref: `refs/heads/${branchName}`,
			sha: baseRefData.object.sha,
		}),
	})

	// Update workflow file
	await fetch(
		`https://api.github.com/repos/${username}/flamecast/contents/${FLAMECAST_WORKFLOW_PATH}`,
		{
			method: "PUT",
			headers,
			body: JSON.stringify({
				message: "chore: update flamecast workflow with status tracking",
				content: getFlamecastWorkflowContentBase64(),
				branch: branchName,
				...(workflowSha ? { sha: workflowSha } : {}),
			}),
		},
	)

	// Create PR
	const prRes = await fetch(
		`https://api.github.com/repos/${username}/flamecast/pulls`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				title: "chore: update flamecast workflow with status tracking",
				head: branchName,
				base: defaultBranch,
				body: "Updates `.github/workflows/flamecast.yml` to include workflow status tracking.\n\nAlso sets `FLAMECAST_API_KEY` as a repository secret.",
			}),
		},
	)

	if (!prRes.ok) {
		const body = await prRes.text()
		return c.json({ error: body || "Failed to create PR" }, prRes.status as 400)
	}

	const pull = (await prRes.json()) as {
		number: number
		html_url: string
	}

	return c.json({
		success: true,
		branchName,
		prNumber: pull.number,
		prUrl: pull.html_url,
	})
})

export default setup
