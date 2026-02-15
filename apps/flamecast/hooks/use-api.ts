import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { queryKeys } from "./query-keys"
import {
	getFlamecastRuns,
	archiveFlamecastRun,
	unarchiveFlamecastRun,
	getFlamecastWorkflowRun,
	getFlamecastWorkflowRunJobs,
	getFlamecastWorkflowRunLogs,
	getFlamecastWorkflowRunOutputs,
	getSetupStatus,
	createRepo,
	saveSecrets,
	resetWorkflow,
	updateWorkflow,
	listPulls,
	getPullRequestStatus,
	closePull,
	mergePull,
	listWorkflowRuns,
	getWorkflowRun,
	getWorkflowRunLogs,
	dispatchWorkflow,
} from "@/lib/actions"

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
	archivedAt: string | null
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
	prompt: string | null
	branchName: string | null
}

export interface PullRequestStatus {
	state: "open" | "closed" | "merged"
	mergeable: boolean
	checks: {
		total: number
		completed: number
		successful: number
		pending: number
		failed: number
	}
	checkRuns: Array<{
		name: string
		status: string
		conclusion: string | null
	}>
}

// ── Query hooks ──────────────────────────────────────────────────────────────

export function useSetupStatus() {
	return useQuery({
		queryKey: queryKeys.setupStatus(),
		queryFn: () => getSetupStatus(),
	})
}

export function usePulls(owner: string, repo: string, user?: string) {
	return useQuery({
		queryKey: queryKeys.pulls(owner, repo),
		queryFn: () => listPulls(owner, repo, user),
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
		queryFn: () => listWorkflowRuns(owner, repo, options?.branch),
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
		queryFn: () => getWorkflowRun(owner, repo, runId),
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
		queryFn: () => getWorkflowRunLogs(owner, repo, runId),
		enabled: (options?.enabled ?? true) && !!owner && !!repo && !!runId,
	})
}

export function useFlamecastRuns(
	repo?: string,
	options?: { refetchInterval?: number; includeArchived?: boolean },
) {
	return useQuery({
		queryKey: queryKeys.flamecastRuns(repo, options?.includeArchived),
		queryFn: () => getFlamecastRuns(repo, options?.includeArchived),
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
		queryFn: () => getFlamecastWorkflowRun(owner, repo, runId),
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
		queryFn: () => getFlamecastWorkflowRunJobs(owner, repo, runId),
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
		queryFn: () => getFlamecastWorkflowRunLogs(owner, repo, runId),
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
		queryFn: () => getFlamecastWorkflowRunOutputs(owner, repo, runId),
		enabled: !!owner && !!repo && !!runId,
	})
}

export function usePullRequestStatus(
	owner: string,
	repo: string,
	number: number,
	options?: { refetchInterval?: number | false; enabled?: boolean },
) {
	return useQuery({
		queryKey: queryKeys.pullRequestStatus(owner, repo, number),
		queryFn: () => getPullRequestStatus(owner, repo, number),
		enabled: (options?.enabled ?? true) && !!owner && !!repo && !!number,
		refetchInterval: options?.refetchInterval,
	})
}

// ── Mutation hooks ───────────────────────────────────────────────────────────

export function useCreateRepo() {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: () => createRepo(),
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
			saveSecrets(vars),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.setupStatus(),
			})
		},
	})
}

export function useResetWorkflow() {
	return useMutation({
		mutationFn: () => resetWorkflow(),
	})
}

export function useUpdateWorkflow() {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: () => updateWorkflow(),
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
			mergePull(vars.owner, vars.repo, vars.number),
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
			closePull(vars.owner, vars.repo, vars.number),
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.pulls(vars.owner, vars.repo),
			})
		},
	})
}

export function useArchiveRun() {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: (vars: { id: string; repo?: string }) =>
			archiveFlamecastRun(vars.id),
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.flamecastRuns(vars.repo),
			})
		},
	})
}

export function useUnarchiveRun() {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: (vars: { id: string; repo?: string }) =>
			unarchiveFlamecastRun(vars.id),
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.flamecastRuns(vars.repo),
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
		}) => dispatchWorkflow(vars),
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.workflowRuns(vars.owner, vars.repo),
			})
		},
	})
}
