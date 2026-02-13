import { type NextRequest, NextResponse } from "next/server"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"
import sodium from "libsodium-wrappers"

export async function POST(request: NextRequest) {
	const creds = await getGitHubCredentials()
	if (!creds)
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

	const body = await request.json()
	const { repo, secrets } = body as {
		repo: string
		secrets: Record<string, string>
	}

	if (!repo || !secrets)
		return NextResponse.json(
			{ error: "repo and secrets are required" },
			{ status: 400 },
		)

	const [owner, name] = repo.split("/")
	if (!owner || !name)
		return NextResponse.json({ error: "Invalid repo format" }, { status: 400 })

	const octokit = createOctokit(creds.accessToken)

	// Get the repo's public key for encrypting secrets
	const { data: publicKey } = await octokit.rest.actions.getRepoPublicKey({
		owner,
		repo: name,
	})

	await sodium.ready
	const binKey = sodium.from_base64(
		publicKey.key,
		sodium.base64_variants.ORIGINAL,
	)

	for (const [secretName, secretValue] of Object.entries(secrets)) {
		if (!secretValue) continue

		const binSecret = sodium.from_string(secretValue)
		const encrypted = sodium.crypto_box_seal(binSecret, binKey)
		const encryptedBase64 = sodium.to_base64(
			encrypted,
			sodium.base64_variants.ORIGINAL,
		)

		await octokit.rest.actions.createOrUpdateRepoSecret({
			owner,
			repo: name,
			secret_name: secretName,
			encrypted_value: encryptedBase64,
			key_id: publicKey.key_id,
		})
	}

	return NextResponse.json({ success: true })
}
