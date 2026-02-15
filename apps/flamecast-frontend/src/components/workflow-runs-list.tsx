"use client"

import { useState, type KeyboardEvent } from "react"
import posthog from "posthog-js"
import {
	useFlamecastRuns,
	useArchiveRun,
	useUnarchiveRun,
	type FlamecastWorkflowRun,
} from "@/hooks/use-api"
import { InlinePRActions } from "@/components/inline-pr-actions"

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

function getStatusLabel(status: string): string {
	switch (status) {
		case "completed":
			return "Completed successfully"
		case "error":
			return "Failed with error"
		case "timed_out":
			return "Timed out (exceeded 45 minutes)"
		case "queued":
			return "Queued, waiting to start"
		case "running":
			return "Currently running"
		default:
			return "Unknown status"
	}
}

function StatusDot({ status }: { status: string }) {
	const label = getStatusLabel(status)

	switch (status) {
		case "completed":
			return (
				<span
					className="inline-block h-2 w-2 shrink-0 rounded-full bg-green-500"
					title={label}
				/>
			)
		case "error":
			return (
				<span
					className="inline-block h-2 w-2 shrink-0 rounded-full bg-red-500"
					title={label}
				/>
			)
		case "timed_out":
			return (
				<span
					className="inline-block h-2 w-2 shrink-0 rounded-full bg-zinc-400"
					title={label}
				/>
			)
		case "queued":
			return (
				<span
					className="inline-block h-2 w-2 shrink-0 rounded-full bg-blue-400"
					title={label}
				/>
			)
		default:
			return (
				<span
					className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500 animate-pulse"
					title={label}
				/>
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

function isFlamecastWorkflowRun(value: unknown): value is FlamecastWorkflowRun {
	if (!value || typeof value !== "object") return false
	const run = value as Partial<FlamecastWorkflowRun>
	return (
		typeof run.id === "string" &&
		typeof run.workflowRunId === "number" &&
		typeof run.createdAt === "string"
	)
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
	const [showArchived, setShowArchived] = useState(false)
	const {
		data,
		isLoading,
		error,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useFlamecastRuns(repo, {
		refetchInterval: 5000,
		includeArchived: showArchived,
	})
	const archiveRun = useArchiveRun()
	const unarchiveRun = useUnarchiveRun()

	const runs = (data?.pages ?? [])
		.flatMap(page => (Array.isArray(page?.runs) ? page.runs : []))
		.filter(isFlamecastWorkflowRun)

	if (isLoading) {
		return <p className="text-sm text-zinc-400">Loading workflow runs...</p>
	}

	if (error) {
		return null
	}

	if (runs.length === 0) {
		return (
			<p className="text-sm text-zinc-500 dark:text-zinc-400">
				No workflow runs yet.
			</p>
		)
	}

	return (
		<div className="flex flex-col gap-1">
			<div className="flex justify-end px-4 pb-1">
				<button
					type="button"
					onClick={() => setShowArchived(prev => !prev)}
					className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
				>
					{showArchived ? "Hide archived" : "Show archived"}
				</button>
			</div>
			{runs.map(run => {
				const isArchived = !!run.archivedAt
				const status = getRunStatus(run)
				const workflowRunUrl = getWorkflowRunUrl(run)
				return (
					<div
						key={run.id}
						onClick={() => navigateToWorkflowRun(workflowRunUrl, run)}
						onKeyDown={event => handleRunKeyDown(event, workflowRunUrl)}
						className={`group flex items-center justify-between rounded-lg px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors ${
							workflowRunUrl ? "cursor-pointer" : ""
						} ${isArchived ? "opacity-50" : ""}`}
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
						<div className="shrink-0 ml-4 flex items-center gap-3">
							{run.completedAt &&
								run.sourceRepo &&
								(() => {
									const parts = run.sourceRepo.split("/")
									if (parts.length < 2) return null
									return (
										<InlinePRActions
											sourceOwner={parts[0]}
											sourceRepo={parts[1]}
											runId={run.workflowRunId}
										/>
									)
								})()}
							<span className="text-xs text-zinc-400">
								{relativeTime(run.createdAt)}
							</span>
							{isArchived ? (
								<button
									type="button"
									onClick={event => {
										event.stopPropagation()
										unarchiveRun.mutate({ id: run.id, repo })
									}}
									className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700"
									title="Unarchive"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										viewBox="0 0 20 20"
										fill="currentColor"
										className="h-3.5 w-3.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
									>
										<path
											fillRule="evenodd"
											d="M4.606 12.97a.75.75 0 0 1-.073 1.058l-3.25 2.86a.75.75 0 0 1-.992-1.126l2.47-2.174H1.75a.75.75 0 0 1 0-1.5h1.011l-2.47-2.174a.75.75 0 1 1 .992-1.126l3.25 2.86a.75.75 0 0 1 .073 1.322ZM15 2a1 1 0 0 1 1 1v11.5a2.5 2.5 0 0 1-2.5 2.5h-5A2.5 2.5 0 0 1 6 14.5V3a1 1 0 0 1 1-1h8Zm-3 3.5a.5.5 0 0 0-1 0v5.38l-1.72-1.72a.5.5 0 0 0-.706.708l2.573 2.573a.5.5 0 0 0 .706 0l2.573-2.573a.5.5 0 0 0-.707-.707L12 10.88V5.5Z"
											clipRule="evenodd"
										/>
									</svg>
								</button>
							) : (
								<button
									type="button"
									onClick={event => {
										event.stopPropagation()
										archiveRun.mutate({ id: run.id, repo })
									}}
									className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700"
									title="Archive"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										viewBox="0 0 20 20"
										fill="currentColor"
										className="h-3.5 w-3.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
									>
										<path d="M2 3a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H2Z" />
										<path
											fillRule="evenodd"
											d="M2 7.5h16l-.811 7.71a2 2 0 0 1-1.99 1.79H4.802a2 2 0 0 1-1.99-1.79L2 7.5ZM7 11a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2H8a1 1 0 0 1-1-1Z"
											clipRule="evenodd"
										/>
									</svg>
								</button>
							)}
						</div>
					</div>
				)
			})}
			{hasNextPage && (
				<div className="flex justify-center px-4 pt-3">
					<button
						type="button"
						onClick={() => fetchNextPage()}
						disabled={isFetchingNextPage}
						className="text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-900"
					>
						{isFetchingNextPage ? "Loading..." : "Load More"}
					</button>
				</div>
			)}
		</div>
	)
}
