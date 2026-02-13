import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { queryKeys } from "./query-keys"
import { getFlamecastRuns } from "@/lib/actions"

// ── Types ────────────────────────────────────────────────────────────────────

export interface SetupStatus {
	username: string
	repoExists: boolean
	hasClaudeToken: boolean
	hasFlamecastPat: boolean
	hasFlamecastApiKey: boolean
}

export interface FlamecastPR {
	number: number
	title: string
	headRefName: string
	url: string
	createdAt: string
	updatedAt: string
}

export interface WorkflowRun {
	id: number
	headBranch: string | null
	status: string | null
	conclusion: string | null
	createdAt: string
	url: string
}

export interface WorkflowRunDetail {
	jobs: Array<{
		id: number
		status: string
		conclusion: string | null
		steps: Array<{
			name: string
			status: string
			conclusion: string | null
			number: number
		}>
	}>
}

export interface WorkflowRunLogs {
	downloadUrl: string
}

export interface FlamecastWorkflowRun {
	id: string
	workflowRunId: number
	userId: string
	repo: string | null
	sourceRepo: string | null
	prompt: string | null
	prUrl: string | null
	startedAt: string | null
	completedAt: string | null
	errorAt: string | null
	errorMessage: string | null
	createdAt: string
}

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

export interface FlamecastCheckRun {
	id: number
	name: string
	status: string
	conclusion: string | null
	html_url: string | null
	started_at: string | null
	completed_at: string | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init)
	if (!res.ok) {
		const body = await res.json().catch(() => ({}))
		throw new Error(body.error || `Request failed (${res.status})`)
	}
	return res.json() as Promise<T>
}

function postJson<T>(url: string, body?: unknown): Promise<T> {
	return fetchJson<T>(url, {
		method: "POST",
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	})
}

// ── Query hooks ──────────────────────────────────────────────────────────────

export function useSetupStatus() {
	return useQuery({
		queryKey: queryKeys.setupStatus(),
		queryFn: () => fetchJson<SetupStatus>("/api/setup/status"),
	})
}

export function usePulls(owner: string, repo: string, user?: string) {
	return useQuery({
		queryKey: queryKeys.pulls(owner, repo),
		queryFn: () => {
			const params = new URLSearchParams()
			if (user) params.set("user", user)
			const qs = params.toString()
			return fetchJson<FlamecastPR[]>(
				`/api/repos/${owner}/${repo}/pulls${qs ? `?${qs}` : ""}`,
			)
		},
		enabled: !!owner && !!repo,
	})
}

export function useWorkflowRuns(
	owner: string,
	repo: string,
	options?: { branch?: string; refetchInterval?: number },
) {
	return useQuery({
		queryKey: queryKeys.workflowRuns(owner, repo),
		queryFn: () => {
			const params = new URLSearchParams()
			if (options?.branch) params.set("branch", options.branch)
			const qs = params.toString()
			return fetchJson<WorkflowRun[]>(
				`/api/repos/${owner}/${repo}/workflows/runs${qs ? `?${qs}` : ""}`,
			)
		},
		enabled: !!owner && !!repo,
		refetchInterval: options?.refetchInterval,
	})
}

export function useWorkflowRun(
	owner: string,
	repo: string,
	runId: number,
	options?: { refetchInterval?: number },
) {
	return useQuery({
		queryKey: queryKeys.workflowRun(owner, repo, runId),
		queryFn: () =>
			fetchJson<WorkflowRunDetail>(
				`/api/repos/${owner}/${repo}/workflows/runs/${runId}`,
			),
		enabled: !!owner && !!repo && !!runId,
		refetchInterval: options?.refetchInterval,
	})
}

export function useWorkflowRunLogs(
	owner: string,
	repo: string,
	runId: number,
	options?: { enabled?: boolean },
) {
	return useQuery({
		queryKey: queryKeys.workflowRunLogs(owner, repo, runId),
		queryFn: () =>
			fetchJson<WorkflowRunLogs>(
				`/api/repos/${owner}/${repo}/workflows/runs/${runId}/logs`,
			),
		enabled: (options?.enabled ?? true) && !!owner && !!repo && !!runId,
	})
}

export function useFlamecastRuns(
	repo?: string,
	options?: { refetchInterval?: number },
) {
	return useQuery({
		queryKey: queryKeys.flamecastRuns(repo),
		queryFn: () => getFlamecastRuns(repo),
		refetchInterval: options?.refetchInterval,
	})
}

export function useFlamecastWorkflowRun(
	owner: string,
	repo: string,
	runId: number,
	options?: { refetchInterval?: number },
) {
	return useQuery({
		queryKey: queryKeys.flamecastWorkflowRun(owner, repo, runId),
		queryFn: () =>
			fetchJson<FlamecastGitHubWorkflowRun>(
				`/api/flamecast/runs/${owner}/${repo}/${runId}`,
			),
		enabled: !!owner && !!repo && !!runId,
		refetchInterval: options?.refetchInterval,
	})
}

export function useFlamecastWorkflowRunJobs(
	owner: string,
	repo: string,
	runId: number,
) {
	return useQuery({
		queryKey: queryKeys.flamecastWorkflowRunJobs(owner, repo, runId),
		queryFn: async () => {
			const data = await fetchJson<{ jobs: FlamecastWorkflowRunJob[] }>(
				`/api/flamecast/runs/${owner}/${repo}/${runId}/jobs`,
			)
			return data.jobs
		},
		enabled: !!owner && !!repo && !!runId,
	})
}

export function useFlamecastWorkflowRunLogs(
	owner: string,
	repo: string,
	runId: number,
) {
	return useQuery({
		queryKey: queryKeys.flamecastWorkflowRunLogs(owner, repo, runId),
		queryFn: () =>
			fetchJson<FlamecastWorkflowLogs>(
				`/api/flamecast/runs/${owner}/${repo}/${runId}/logs`,
			),
		enabled: !!owner && !!repo && !!runId,
	})
}

export function useFlamecastWorkflowRunOutputs(
	owner: string,
	repo: string,
	runId: number,
) {
	return useQuery({
		queryKey: queryKeys.flamecastWorkflowRunOutputs(owner, repo, runId),
		queryFn: () =>
			fetchJson<FlamecastWorkflowOutputs>(
				`/api/flamecast/runs/${owner}/${repo}/${runId}/outputs`,
			),
		enabled: !!owner && !!repo && !!runId,
	})
}

export function useFlamecastWorkflowRunChecks(
	owner: string,
	repo: string,
	runId: number,
	options?: { enabled?: boolean; refetchInterval?: number },
) {
	return useQuery({
		queryKey: queryKeys.flamecastWorkflowRunChecks(owner, repo, runId),
		queryFn: async () => {
			const data = await fetchJson<{ checks: FlamecastCheckRun[] }>(
				`/api/flamecast/runs/${owner}/${repo}/${runId}/checks`,
			)
			return data.checks
		},
		enabled: (options?.enabled ?? true) && !!owner && !!repo && !!runId,
		refetchInterval: options?.refetchInterval,
	})
}

// ── Mutation hooks ───────────────────────────────────────────────────────────

export function useCreateRepo() {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: () =>
			postJson<{ created: boolean; repo: string }>("/api/setup/repo"),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.setupStatus(),
			})
		},
	})
}

export function useSaveSecrets() {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: (vars: { repo: string; secrets: Record<string, string> }) =>
			postJson<{ success: boolean }>("/api/setup/secrets", vars),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.setupStatus(),
			})
		},
	})
}

export function useResetWorkflow() {
	return useMutation({
		mutationFn: () =>
			postJson<{
				success: boolean
				branchName: string
				prNumber: number
				prUrl: string
			}>("/api/setup/workflow/reset"),
	})
}

export function useUpdateWorkflow() {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: () =>
			postJson<{
				success: boolean
				branchName: string
				prNumber: number
				prUrl: string
			}>("/api/setup/workflow/update"),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.setupStatus(),
			})
		},
	})
}

export function useMergePull() {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: (vars: { owner: string; repo: string; number: number }) =>
			postJson<{ success: boolean; merged: boolean }>(
				`/api/repos/${vars.owner}/${vars.repo}/pulls/${vars.number}/merge`,
			),
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.pulls(vars.owner, vars.repo),
			})
		},
	})
}

export function useClosePull() {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: (vars: { owner: string; repo: string; number: number }) =>
			postJson<{ success: boolean; closed: boolean }>(
				`/api/repos/${vars.owner}/${vars.repo}/pulls/${vars.number}/close`,
			),
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.pulls(vars.owner, vars.repo),
			})
		},
	})
}

export function useDispatchWorkflow() {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: (vars: {
			owner: string
			repo: string
			prompt: string
			baseBranch?: string
			ref?: string
			targetRepo?: string
		}) =>
			postJson<{ success: boolean }>(
				`/api/repos/${vars.owner}/${vars.repo}/workflows/dispatch`,
				{
					prompt: vars.prompt,
					baseBranch: vars.baseBranch,
					ref: vars.ref,
					targetRepo: vars.targetRepo,
				},
			),
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.workflowRuns(vars.owner, vars.repo),
			})
		},
	})
}
