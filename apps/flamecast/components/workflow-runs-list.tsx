"use client"

import type { KeyboardEvent } from "react"
import posthog from "posthog-js"
import { useFlamecastRuns, type FlamecastWorkflowRun } from "@/hooks/use-api"

function getRunStatus(run: FlamecastWorkflowRun) {
	if (run.errorAt) return "error"
	if (run.completedAt) return "completed"
	if (!run.startedAt) {
		const queuedAge = Date.now() - new Date(run.createdAt).getTime()
		if (queuedAge > 45 * 60 * 1000) return "timed_out"
		return "queued"
	}
	const runningAge = Date.now() - new Date(run.startedAt).getTime()
	if (runningAge > 45 * 60 * 1000) return "timed_out"
	return "running"
}

function StatusDot({ status }: { status: string }) {
	switch (status) {
		case "completed":
			return (
				<span className="inline-block h-2 w-2 shrink-0 rounded-full bg-green-500" />
			)
		case "error":
			return (
				<span className="inline-block h-2 w-2 shrink-0 rounded-full bg-red-500" />
			)
		case "timed_out":
			return (
				<span className="inline-block h-2 w-2 shrink-0 rounded-full bg-zinc-400" />
			)
		case "queued":
			return (
				<span className="inline-block h-2 w-2 shrink-0 rounded-full bg-blue-400" />
			)
		default:
			return (
				<span className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500 animate-pulse" />
			)
	}
}

function relativeTime(date: string) {
	const diff = Date.now() - new Date(date).getTime()
	const seconds = Math.floor(diff / 1000)
	if (seconds < 60) return "just now"
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}

function getWorkflowRunUrl(run: FlamecastWorkflowRun) {
	if (!run.sourceRepo) return null
	const [owner, repo] = run.sourceRepo.split("/")
	if (!owner || !repo) return null
	return `/${owner}/${repo}/actions/runs/${run.workflowRunId}`
}

function navigateToWorkflowRun(url: string | null, run?: FlamecastWorkflowRun) {
	if (!url) return
	if (run) {
		posthog.capture("workflow_run_clicked", {
			status: run.errorAt
				? "error"
				: run.completedAt
					? "completed"
					: run.startedAt
						? "running"
						: "queued",
			has_pr: !!run.prUrl,
			repo: run.repo,
		})
	}
	window.location.assign(url)
}

function handleRunKeyDown(
	event: KeyboardEvent<HTMLDivElement>,
	url: string | null,
) {
	if (!url) return
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault()
		navigateToWorkflowRun(url)
	}
}

export function WorkflowRunsList({ repo }: { repo?: string }) {
	const {
		data: runs,
		isLoading,
		error,
	} = useFlamecastRuns(repo, {
		refetchInterval: 5000,
	})

	if (isLoading) {
		return <p className="text-sm text-zinc-400">Loading workflow runs...</p>
	}

	if (error) {
		return null
	}

	if (!runs || runs.length === 0) {
		return (
			<p className="text-sm text-zinc-500 dark:text-zinc-400">
				No workflow runs yet.
			</p>
		)
	}

	return (
		<div className="flex flex-col gap-1">
			{runs.map(run => {
				const status = getRunStatus(run)
				const workflowRunUrl = getWorkflowRunUrl(run)
				return (
					<div
						key={run.id}
						onClick={() => navigateToWorkflowRun(workflowRunUrl, run)}
						onKeyDown={event => handleRunKeyDown(event, workflowRunUrl)}
						className={`flex items-center justify-between rounded-lg px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors ${
							workflowRunUrl ? "cursor-pointer" : ""
						}`}
						role={workflowRunUrl ? "link" : undefined}
						tabIndex={workflowRunUrl ? 0 : undefined}
					>
						<div className="flex items-center gap-3 min-w-0">
							<StatusDot status={status} />
							<div className="flex flex-col gap-0.5 min-w-0">
								<p className="text-sm text-zinc-900 dark:text-zinc-100 truncate">
									{run.prompt || "No prompt"}
								</p>
								<div className="flex items-center gap-2">
									{run.repo && !repo && (
										<span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
											{run.repo}
										</span>
									)}
									{run.prUrl ? (
										<a
											href={run.prUrl}
											target="_blank"
											rel="noopener noreferrer"
											onClick={event => event.stopPropagation()}
											className="text-sm text-blue-600 dark:text-blue-400 hover:underline truncate"
										>
											PR
										</a>
									) : null}
								</div>
								{run.errorMessage && (
									<p className="text-xs text-red-500 dark:text-red-400 truncate">
										{run.errorMessage}
									</p>
								)}
							</div>
						</div>
						<span className="shrink-0 ml-4 text-xs text-zinc-400">
							{relativeTime(run.createdAt)}
						</span>
					</div>
				)
			})}
		</div>
	)
}
