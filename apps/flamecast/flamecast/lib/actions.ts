"use server"

import { withAuth } from "@workos-inc/authkit-nextjs"
import { getUserApiKey } from "@/lib/api-key-auth"
import type { FlamecastWorkflowRun } from "@/hooks/use-api"

const BACKEND_URL =
	process.env.NEXT_PUBLIC_BACKEND_URL || "https://api.flamecast.dev"

export interface FlamecastGitHubWorkflowRun {
	id: number
	html_url: string
	status: string | null
	conclusion: string | null
	run_started_at: string | null
	updated_at: string
}

export interface FlamecastWorkflowRunJob {
	id: number
	name: string
	status: string | null
	conclusion: string | null
}

export interface FlamecastWorkflowLogs {
	downloadUrl: string | null
	content: string | null
	truncated: boolean
}

export interface FlamecastWorkflowOutputs {
	available: boolean
	prUrl: string | null
	claudeLogs: string | null
	claudeLogsTruncated: boolean
}

const DEFAULT_WORKFLOW_LOGS: FlamecastWorkflowLogs = {
	downloadUrl: null,
	content: null,
	truncated: false,
}

const DEFAULT_WORKFLOW_OUTPUTS: FlamecastWorkflowOutputs = {
	available: false,
	prUrl: null,
	claudeLogs: null,
	claudeLogsTruncated: false,
}

async function getBackendApiKey() {
	const { user } = await withAuth()
	if (!user) throw new Error("Unauthorized")

	const apiKey = await getUserApiKey(user.id)
	if (!apiKey) throw new Error("No API key found")

	return apiKey
}

async function getBackendErrorMessage(res: Response) {
	const body = (await res.json().catch(() => null)) as { error?: string } | null
	return body?.error || `Backend request failed (${res.status})`
}

async function callBackend(pathname: string, searchParams?: URLSearchParams) {
	const apiKey = await getBackendApiKey()
	const url = new URL(pathname, BACKEND_URL)
	if (searchParams) {
		for (const [key, value] of searchParams.entries()) {
			url.searchParams.set(key, value)
		}
	}

	return fetch(url.toString(), {
		headers: { Authorization: `Bearer ${apiKey}` },
		cache: "no-store",
	})
}

export async function getFlamecastRuns(
	repo?: string,
): Promise<FlamecastWorkflowRun[]> {
	const searchParams = new URLSearchParams()
	if (repo) searchParams.set("repo", repo)

	const res = await callBackend("/workflow-runs", searchParams)

	if (!res.ok) {
		throw new Error(await getBackendErrorMessage(res))
	}

	return res.json() as Promise<FlamecastWorkflowRun[]>
}

export async function getFlamecastWorkflowRun(
	owner: string,
	repo: string,
	runId: number,
): Promise<FlamecastGitHubWorkflowRun | null> {
	const searchParams = new URLSearchParams({
		owner,
		repo,
		runId: String(runId),
	})

	const res = await callBackend("/workflow-runs/github-run", searchParams)

	if (res.status === 404) return null

	if (!res.ok) {
		throw new Error(await getBackendErrorMessage(res))
	}

	return res.json() as Promise<FlamecastGitHubWorkflowRun>
}

export async function getFlamecastWorkflowRunJobs(
	owner: string,
	repo: string,
	runId: number,
): Promise<FlamecastWorkflowRunJob[]> {
	const searchParams = new URLSearchParams({
		owner,
		repo,
		runId: String(runId),
	})
	const res = await callBackend("/workflow-runs/github-run/jobs", searchParams)

	if (res.status === 404) return []

	if (!res.ok) {
		throw new Error(await getBackendErrorMessage(res))
	}

	const data = (await res.json()) as { jobs: FlamecastWorkflowRunJob[] }
	return data.jobs
}

export async function getFlamecastWorkflowRunLogs(
	owner: string,
	repo: string,
	runId: number,
): Promise<FlamecastWorkflowLogs> {
	const searchParams = new URLSearchParams({
		owner,
		repo,
		runId: String(runId),
	})
	const res = await callBackend("/workflow-runs/github-run/logs", searchParams)

	if (res.status === 404) return DEFAULT_WORKFLOW_LOGS

	if (!res.ok) {
		throw new Error(await getBackendErrorMessage(res))
	}

	return res.json() as Promise<FlamecastWorkflowLogs>
}

export async function getFlamecastWorkflowRunOutputs(
	owner: string,
	repo: string,
	runId: number,
): Promise<FlamecastWorkflowOutputs> {
	const searchParams = new URLSearchParams({
		owner,
		repo,
		runId: String(runId),
	})
	const res = await callBackend(
		"/workflow-runs/github-run/outputs",
		searchParams,
	)

	if (res.status === 404) return DEFAULT_WORKFLOW_OUTPUTS

	if (!res.ok) {
		throw new Error(await getBackendErrorMessage(res))
	}

	return res.json() as Promise<FlamecastWorkflowOutputs>
}
