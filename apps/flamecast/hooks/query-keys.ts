export const queryKeys = {
	setupStatus: () => ["setup", "status"] as const,
	pulls: (owner: string, repo: string) =>
		["repos", owner, repo, "pulls"] as const,
	workflowRuns: (owner: string, repo: string) =>
		["repos", owner, repo, "workflows", "runs"] as const,
	workflowRun: (owner: string, repo: string, runId: number) =>
		["repos", owner, repo, "workflows", "runs", runId] as const,
	workflowRunLogs: (owner: string, repo: string, runId: number) =>
		["repos", owner, repo, "workflows", "runs", runId, "logs"] as const,
	flamecastRuns: (repo?: string) =>
		repo
			? (["flamecast", "runs", repo] as const)
			: (["flamecast", "runs"] as const),
	flamecastWorkflowRun: (owner: string, repo: string, runId: number) =>
		["flamecast", "runs", owner, repo, runId] as const,
	flamecastWorkflowRunJobs: (owner: string, repo: string, runId: number) =>
		["flamecast", "runs", owner, repo, runId, "jobs"] as const,
	flamecastWorkflowRunLogs: (owner: string, repo: string, runId: number) =>
		["flamecast", "runs", owner, repo, runId, "logs"] as const,
	flamecastWorkflowRunOutputs: (owner: string, repo: string, runId: number) =>
		["flamecast", "runs", owner, repo, runId, "outputs"] as const,
	pullRequestStatus: (owner: string, repo: string, number: number) =>
		["repos", owner, repo, "pulls", number, "status"] as const,
}
