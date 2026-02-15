"use client"

import Link from "next/link"
import { notFound } from "next/navigation"
import {
	useFlamecastWorkflowRun,
	useFlamecastWorkflowRunJobs,
	useFlamecastWorkflowRunLogs,
	useFlamecastWorkflowRunOutputs,
} from "@/hooks/use-api"
import { PullRequestActions } from "./pull-request-actions"

const MAX_CLAUDE_LOGS_CHARS = 200_000
const MAX_WORKFLOW_LOG_CHARS = 300_000

function formatDateTime(value: string | null | undefined) {
	if (!value) return "-"
	return new Date(value).toLocaleString()
}

function parsePrUrl(
	url: string,
): { owner: string; repo: string; number: number } | null {
	const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
	if (!match) return null
	return { owner: match[1], repo: match[2], number: Number(match[3]) }
}

interface WorkflowRunDetailsProps {
	owner: string
	repo: string
	runId: number
}

export function WorkflowRunDetails({
	owner,
	repo,
	runId,
}: WorkflowRunDetailsProps) {
	const {
		data: run,
		isLoading: runLoading,
		error: runError,
	} = useFlamecastWorkflowRun(owner, repo, runId)

	const { data: jobs = [], isLoading: jobsLoading } =
		useFlamecastWorkflowRunJobs(owner, repo, runId)

	const { data: workflowLogs, isLoading: logsLoading } =
		useFlamecastWorkflowRunLogs(owner, repo, runId)

	const { data: outputs, isLoading: outputsLoading } =
		useFlamecastWorkflowRunOutputs(owner, repo, runId)

	if (runError) {
		if (
			runError instanceof Error &&
			runError.message.includes("Run not found")
		) {
			notFound()
		}
		throw runError
	}

	if (runLoading) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
				<main className="flex min-h-screen w-full max-w-4xl flex-col gap-8 py-16 px-8 bg-white dark:bg-black">
					<div className="flex items-center justify-center">
						<p className="text-zinc-500 dark:text-zinc-400">
							Loading workflow run...
						</p>
					</div>
				</main>
			</div>
		)
	}

	if (!run) {
		notFound()
	}

	const logsDownloadUrl = workflowLogs?.downloadUrl

	// Parse PR URL to get the target repository (where the PR was opened)
	// Fall back to URL params if PR URL is not available
	const prInfo = outputs?.prUrl ? parsePrUrl(outputs.prUrl) : null
	const displayOwner = prInfo?.owner ?? owner
	const displayRepo = prInfo?.repo ?? repo

	return (
		<div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
			<main className="flex min-h-screen w-full max-w-4xl flex-col gap-8 py-16 px-8 bg-white dark:bg-black">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3 min-w-0">
						<Link
							href={`/${displayOwner}/${displayRepo}`}
							className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
						>
							{displayOwner}/{displayRepo}
						</Link>
						<span className="text-zinc-300 dark:text-zinc-600">/</span>
						<h1 className="truncate text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
							run {runId}
						</h1>
					</div>
				</div>

				<div className="grid gap-2 text-sm text-zinc-600 dark:text-zinc-300">
					{outputs?.prompt && (
						<p>
							<span className="font-medium text-zinc-900 dark:text-zinc-100">
								Prompt:
							</span>{" "}
							{outputs.prompt}
						</p>
					)}
					<p>
						<span className="font-medium text-zinc-900 dark:text-zinc-100">
							Status:
						</span>{" "}
						{run.status || "-"}
						{run.conclusion ? ` (${run.conclusion})` : ""}
					</p>
					{outputs?.prUrl && outputs?.branchName && (
						<p>
							<span className="font-medium text-zinc-900 dark:text-zinc-100">
								Branch:
							</span>{" "}
							{outputs.branchName}
						</p>
					)}
					<p>
						<span className="font-medium text-zinc-900 dark:text-zinc-100">
							Started:
						</span>{" "}
						{formatDateTime(run.run_started_at)}
					</p>
					<p>
						<span className="font-medium text-zinc-900 dark:text-zinc-100">
							Updated:
						</span>{" "}
						{formatDateTime(run.updated_at)}
					</p>
					<div className="flex flex-wrap gap-4 pt-1">
						<a
							href={run.html_url}
							target="_blank"
							rel="noopener noreferrer"
							className="text-blue-600 dark:text-blue-400 hover:underline"
						>
							Open run on GitHub
						</a>
						{logsDownloadUrl ? (
							<a
								href={logsDownloadUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="text-blue-600 dark:text-blue-400 hover:underline"
							>
								Download GitHub logs (.zip)
							</a>
						) : null}
					</div>
				</div>

				<div className="flex flex-col gap-3">
					<h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
						Flamecast Action Outputs
					</h2>
					{outputsLoading ? (
						<p className="text-sm text-zinc-500 dark:text-zinc-400">
							Loading outputs...
						</p>
					) : outputs?.available ? (
						<div className="flex flex-col gap-4">
							<div className="text-sm text-zinc-600 dark:text-zinc-300">
								<span className="font-medium text-zinc-900 dark:text-zinc-100">
									pr_url:
								</span>{" "}
								{outputs.prUrl ? (
									<PullRequestActions prUrl={outputs.prUrl} />
								) : (
									"-"
								)}
							</div>
							<div className="flex flex-col gap-2">
								<p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
									claude_logs:
								</p>
								{outputs.claudeLogs ? (
									<pre className="max-h-[560px] overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900 p-4 text-xs text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap break-words">
										{outputs.claudeLogs}
									</pre>
								) : (
									<p className="text-sm text-zinc-500 dark:text-zinc-400">-</p>
								)}
								{outputs.claudeLogsTruncated && (
									<p className="text-xs text-zinc-500 dark:text-zinc-400">
										Showing first {MAX_CLAUDE_LOGS_CHARS.toLocaleString()}{" "}
										characters. Use the GitHub logs link above for the full run
										logs.
									</p>
								)}
							</div>
						</div>
					) : (
						<p className="text-sm text-zinc-500 dark:text-zinc-400">
							No Flamecast outputs artifact found for this run. Update the
							workflow using Flamecast settings and rerun to capture outputs.
						</p>
					)}
				</div>

				<div className="flex flex-col gap-3">
					<h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
						GitHub Workflow Logs
					</h2>
					{logsLoading ? (
						<p className="text-sm text-zinc-500 dark:text-zinc-400">
							Loading logs...
						</p>
					) : workflowLogs?.content ? (
						<>
							<pre className="max-h-[560px] overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900 p-4 text-xs text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap break-words">
								{workflowLogs.content}
							</pre>
							{workflowLogs.truncated && (
								<p className="text-xs text-zinc-500 dark:text-zinc-400">
									Showing first {MAX_WORKFLOW_LOG_CHARS.toLocaleString()}{" "}
									characters. Use the GitHub logs link above for complete logs.
								</p>
							)}
						</>
					) : (
						<p className="text-sm text-zinc-500 dark:text-zinc-400">
							Unable to load logs inline for this run.
						</p>
					)}
				</div>

				<div className="flex flex-col gap-2">
					<h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
						Jobs
					</h2>
					{jobsLoading ? (
						<p className="text-sm text-zinc-500 dark:text-zinc-400 px-1">
							Loading jobs...
						</p>
					) : (
						<div className="flex flex-col gap-1">
							{jobs.map(job => (
								<div
									key={job.id}
									className="rounded-lg px-4 py-3 border border-zinc-200 dark:border-zinc-800"
								>
									<p className="text-sm text-zinc-900 dark:text-zinc-100">
										{job.name}
									</p>
									<p className="text-xs text-zinc-500 dark:text-zinc-400">
										{job.status || "-"}
										{job.conclusion ? ` (${job.conclusion})` : ""}
									</p>
								</div>
							))}
							{jobs.length === 0 ? (
								<p className="text-sm text-zinc-500 dark:text-zinc-400 px-1">
									No job details available.
								</p>
							) : null}
						</div>
					)}
				</div>
			</main>
		</div>
	)
}
