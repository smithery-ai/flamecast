import { NextResponse } from "next/server"
import { withAuth } from "@workos-inc/authkit-nextjs"
import { getUserApiKey } from "@/lib/api-key-auth"

const BACKEND_URL =
	process.env.NEXT_PUBLIC_BACKEND_URL || "https://api.flamecast.dev"

async function getBackendApiKey() {
	const { user } = await withAuth()
	if (!user) throw new Error("Unauthorized")

	const apiKey = await getUserApiKey(user.id)
	if (!apiKey) throw new Error("No API key found")

	return apiKey
}

export async function GET(
	_request: Request,
	{
		params,
	}: {
		params: Promise<{ owner: string; repo: string; runId: string }>
	},
) {
	try {
		const apiKey = await getBackendApiKey()
		const { owner, repo, runId } = await params

		const url = new URL("/workflow-runs/github-run/outputs", BACKEND_URL)
		url.searchParams.set("owner", owner)
		url.searchParams.set("repo", repo)
		url.searchParams.set("runId", runId)

		const res = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${apiKey}` },
			cache: "no-store",
		})

		if (res.status === 404) {
			return NextResponse.json({
				available: false,
				prUrl: null,
				claudeLogs: null,
				claudeLogsTruncated: false,
			})
		}

		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			return NextResponse.json(
				{ error: body.error || "Backend request failed" },
				{ status: res.status },
			)
		}

		const data = await res.json()
		return NextResponse.json(data)
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Internal error" },
			{ status: 500 },
		)
	}
}
