import type {
	FlamecastWorkflowRun,
	SetupStatus,
	FlamecastPR,
	WorkflowRun,
	WorkflowRunDetail,
	WorkflowRunLogs,
	PullRequestStatus,
} from "@/hooks/use-api"
import { BACKEND_URL } from "@/lib/backend-url"

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
	prompt: string | null
	branchName: string | null
}

interface ApiKeyInfo {
	id: string
	name: string | null
	description: string | null
	createdAt: string
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
	prompt: null,
	branchName: null,
}

let cachedBackendApiKey: string | null = null

function clearBackendApiKey() {
	cachedBackendApiKey = null
}

async function getBackendApiKey(options?: { forceRefresh?: boolean }) {
	if (cachedBackendApiKey && !options?.forceRefresh) return cachedBackendApiKey

	const url = new URL("/auth/api-key", BACKEND_URL)
	const res = await fetch(url.toString(), {
		credentials: "include",
		cache: "no-store",
	})

	if (!res.ok) {
		throw new Error(await getBackendErrorMessage(res))
	}

	const body = (await res.json().catch(() => null)) as
		| { apiKey?: string }
		| null
	const apiKey = body?.apiKey

	if (!apiKey) throw new Error("No API key found")

	cachedBackendApiKey = apiKey
	return apiKey
}

async function getBackendErrorMessage(res: Response) {
	const body = (await res.json().catch(() => null)) as { error?: string } | null
	return body?.error || `Backend request failed (${res.status})`
}

async function backendFetch(
	pathname: string,
	init?: RequestInit,
	searchParams?: URLSearchParams,
) {
	let apiKey = await getBackendApiKey()
	const url = new URL(pathname, BACKEND_URL)
	if (searchParams) {
		for (const [key, value] of searchParams.entries()) {
			url.searchParams.set(key, value)
		}
	}

	let res = await fetch(url.toString(), {
		...init,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...(init?.headers ?? {}),
		},
		cache: "no-store",
	})

	if (res.status === 401) {
		clearBackendApiKey()
		apiKey = await getBackendApiKey({ forceRefresh: true })
		res = await fetch(url.toString(), {
			...init,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				...(init?.headers ?? {}),
			},
			cache: "no-store",
		})
	}

	return res
}

async function callBackend(pathname: string, searchParams?: URLSearchParams) {
	return backendFetch(pathname, undefined, searchParams)
}

async function callBackendPost(pathname: string, body?: unknown) {
	return backendFetch(pathname, {
		method: "POST",
		headers: {
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	})
}

async function callBackendPatch(pathname: string, body?: unknown) {
	return backendFetch(pathname, {
		method: "PATCH",
		headers: {
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	})
}

async function callBackendDelete(pathname: string) {
	return backendFetch(pathname, {
		method: "DELETE",
	})
}

// ── Chat types ───────────────────────────────────────────────────────────────

export interface FlamecastChat {
	id: string
	userId: string
	title: string
	repo: string | null
	sourceRepoId: string | null
	archivedAt: string | null
	createdAt: string
	updatedAt: string
	lastPrompt?: string | null
	runCount?: number
	latestRunStatus?: "running" | "completed" | "error" | "queued" | null
}

export interface FlamecastChatsResponse {
	chats: FlamecastChat[]
	hasMore: boolean
	nextCursor: string | null
}

export interface FlamecastChatDetail extends FlamecastChat {
	runs: FlamecastWorkflowRun[]
}

export interface FlamecastRunsResponse {
	runs: FlamecastWorkflowRun[]
	hasMore: boolean
	nextCursor: string | null
}

export async function getFlamecastRuns(
	repo?: string,
	includeArchived?: boolean,
	cursor?: string,
): Promise<FlamecastRunsResponse> {
	const searchParams = new URLSearchParams()
	if (repo) searchParams.set("repo", repo)
	if (includeArchived) searchParams.set("includeArchived", "true")
	if (cursor) searchParams.set("cursor", cursor)

	const res = await callBackend("/workflow-runs", searchParams)

	if (!res.ok) {
		throw new Error(await getBackendErrorMessage(res))
	}

	return res.json() as Promise<FlamecastRunsResponse>
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

export async function archiveFlamecastRun(id: string): Promise<void> {
	const res = await callBackendPatch(`/workflow-runs/${id}/archive`)
	if (!res.ok) {
		throw new Error(await getBackendErrorMessage(res))
	}
}

export async function unarchiveFlamecastRun(id: string): Promise<void> {
	const res = await callBackendPatch(`/workflow-runs/${id}/unarchive`)
	if (!res.ok) {
		throw new Error(await getBackendErrorMessage(res))
	}
}

// ── Chats ────────────────────────────────────────────────────────────────────

export async function getChats(
	repo?: string,
	includeArchived?: boolean,
	cursor?: string,
): Promise<FlamecastChatsResponse> {
	const searchParams = new URLSearchParams()
	if (repo) searchParams.set("repo", repo)
	if (includeArchived) searchParams.set("includeArchived", "true")
	if (cursor) searchParams.set("cursor", cursor)

	const res = await callBackend("/chats", searchParams)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<FlamecastChatsResponse>
}

export async function getChat(chatId: string): Promise<FlamecastChatDetail> {
	const res = await callBackend(`/chats/${chatId}`)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<FlamecastChatDetail>
}

export async function createChat(vars: {
	title: string
	repo?: string
	sourceRepoId?: string
}): Promise<{ success: boolean; id: string }> {
	const res = await callBackendPost("/chats", vars)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<{ success: boolean; id: string }>
}

export async function updateChatTitle(
	chatId: string,
	title: string,
): Promise<void> {
	const res = await callBackendPatch(`/chats/${chatId}`, { title })
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
}

export async function archiveChat(chatId: string): Promise<void> {
	const res = await callBackendPatch(`/chats/${chatId}/archive`)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
}

export async function unarchiveChat(chatId: string): Promise<void> {
	const res = await callBackendPatch(`/chats/${chatId}/unarchive`)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
}

// ── Setup ────────────────────────────────────────────────────────────────────

export async function getSetupStatus(): Promise<SetupStatus> {
	const res = await callBackend("/setup/status")
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<SetupStatus>
}

export async function createRepo(): Promise<{
	created: boolean
	repo: string
}> {
	const res = await callBackendPost("/setup/repo")
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<{ created: boolean; repo: string }>
}

export async function saveSecrets(vars: {
	repo: string
	secrets: Record<string, string>
}): Promise<{ success: boolean }> {
	const res = await callBackendPost("/setup/secrets", vars)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<{ success: boolean }>
}

export async function resetWorkflow(): Promise<{
	success: boolean
	branchName: string
	prNumber: number
	prUrl: string
}> {
	const res = await callBackendPost("/setup/workflow/reset")
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<{
		success: boolean
		branchName: string
		prNumber: number
		prUrl: string
	}>
}

export async function updateWorkflow(): Promise<{
	success: boolean
	branchName: string
	prNumber: number
	prUrl: string
}> {
	const res = await callBackendPost("/setup/workflow/update")
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<{
		success: boolean
		branchName: string
		prNumber: number
		prUrl: string
	}>
}

// ── GitHub User ─────────────────────────────────────────────────────────────

export interface GitHubAuthenticatedUser {
	login: string
}

export interface GitHubRepositorySummary {
	name: string
	full_name: string
	owner: { login: string }
	description: string | null
	private: boolean
	language: string | null
	updated_at: string | null
}

export async function getGitHubAuthenticatedUser(): Promise<GitHubAuthenticatedUser> {
	const res = await callBackend("/github/user")
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<GitHubAuthenticatedUser>
}

export async function listGitHubUserRepositories(): Promise<
	GitHubRepositorySummary[]
> {
	const res = await callBackend("/github/user/repos")
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<GitHubRepositorySummary[]>
}

// ── GitHub PRs ───────────────────────────────────────────────────────────────

export async function listPulls(
	owner: string,
	repo: string,
	user?: string,
): Promise<FlamecastPR[]> {
	const searchParams = new URLSearchParams()
	if (user) searchParams.set("user", user)
	const qs = searchParams.toString()
	const res = await callBackend(
		`/github/repos/${owner}/${repo}/pulls${qs ? `?${qs}` : ""}`,
	)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<FlamecastPR[]>
}

export async function getPullRequestStatus(
	owner: string,
	repo: string,
	number: number,
): Promise<PullRequestStatus> {
	const res = await callBackend(
		`/github/repos/${owner}/${repo}/pulls/${number}/status`,
	)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<PullRequestStatus>
}

export async function closePull(
	owner: string,
	repo: string,
	number: number,
): Promise<{ success: boolean; closed: boolean }> {
	const res = await callBackendPost(
		`/github/repos/${owner}/${repo}/pulls/${number}/close`,
	)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<{ success: boolean; closed: boolean }>
}

export async function mergePull(
	owner: string,
	repo: string,
	number: number,
): Promise<{ success: boolean; merged: boolean }> {
	const res = await callBackendPost(
		`/github/repos/${owner}/${repo}/pulls/${number}/merge`,
	)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<{ success: boolean; merged: boolean }>
}

// ── GitHub Workflows ─────────────────────────────────────────────────────────

export async function listWorkflowRuns(
	owner: string,
	repo: string,
	branch?: string,
): Promise<WorkflowRun[]> {
	const searchParams = new URLSearchParams()
	if (branch) searchParams.set("branch", branch)
	const qs = searchParams.toString()
	const res = await callBackend(
		`/github/repos/${owner}/${repo}/workflows/runs${qs ? `?${qs}` : ""}`,
	)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<WorkflowRun[]>
}

export async function getWorkflowRun(
	owner: string,
	repo: string,
	runId: number,
): Promise<WorkflowRunDetail> {
	const res = await callBackend(
		`/github/repos/${owner}/${repo}/workflows/runs/${runId}`,
	)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<WorkflowRunDetail>
}

export async function getWorkflowRunLogs(
	owner: string,
	repo: string,
	runId: number,
): Promise<WorkflowRunLogs> {
	const res = await callBackend(
		`/github/repos/${owner}/${repo}/workflows/runs/${runId}/logs`,
	)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<WorkflowRunLogs>
}

export async function dispatchWorkflow(vars: {
	owner: string
	repo: string
	prompt: string
	baseBranch?: string
	ref?: string
	targetRepo?: string
	chatId?: string
}): Promise<{ success: boolean }> {
	const res = await callBackendPost(
		`/github/repos/${vars.owner}/${vars.repo}/workflows/dispatch`,
		{
			prompt: vars.prompt,
			baseBranch: vars.baseBranch,
			ref: vars.ref,
			targetRepo: vars.targetRepo,
			chatId: vars.chatId,
		},
	)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<{ success: boolean }>
}

// ── API Keys ─────────────────────────────────────────────────────────────────

export async function listApiKeys(): Promise<{ keys: ApiKeyInfo[] }> {
	const res = await callBackend("/api-keys")
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<{ keys: ApiKeyInfo[] }>
}

export async function createApiKey(
	name?: string,
	description?: string,
): Promise<{ key: string; id: string }> {
	const res = await callBackendPost("/api-keys", { name, description })
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<{ key: string; id: string }>
}

export async function deleteApiKey(id: string): Promise<{ success: boolean }> {
	const res = await callBackendDelete(`/api-keys/${id}`)
	if (!res.ok) throw new Error(await getBackendErrorMessage(res))
	return res.json() as Promise<{ success: boolean }>
}
