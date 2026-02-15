"use client"

import { useState } from "react"
import { Link } from "@tanstack/react-router"
import posthog from "posthog-js"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
	useChat,
	useUpdateChatTitle,
	useDispatchWorkflow,
	useFlamecastWorkflowRunOutputs,
	type FlamecastWorkflowRun,
} from "@/hooks/use-api"
import { InlinePRActions } from "@/components/inline-pr-actions"

const MAX_CLAUDE_LOGS_CHARS = 200_000

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

function RunStatusBadge({ run }: { run: FlamecastWorkflowRun }) {
	if (run.errorAt)
		return (
			<span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
				<span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
				Error
			</span>
		)
	if (run.completedAt)
		return (
			<span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
				<span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
				Completed
			</span>
		)
	if (run.startedAt)
		return (
			<span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
				<span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
				Running
			</span>
		)
	return (
		<span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
			<span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400" />
			Queued
		</span>
	)
}

function RunMessage({ run }: { run: FlamecastWorkflowRun }) {
	const sourceRepo = run.sourceRepo?.split("/") ?? []
	const runDetailUrl =
		sourceRepo.length >= 2
			? `/${sourceRepo[0]}/${sourceRepo[1]}/actions/runs/${run.workflowRunId}`
			: null
	const isRunning = !!run.startedAt && !run.completedAt && !run.errorAt
	const canFetchOutputs = sourceRepo.length >= 2 && !!run.workflowRunId

	const {
		data: outputs,
		isLoading: outputsLoading,
		error: outputsError,
	} = useFlamecastWorkflowRunOutputs(
		sourceRepo[0] ?? "",
		sourceRepo[1] ?? "",
		run.workflowRunId,
		{
			enabled: canFetchOutputs,
			refetchInterval: isRunning ? 10_000 : false,
		},
	)
	const prUrl = outputs?.prUrl ?? run.prUrl

	return (
		<div className="flex flex-col gap-3">
			<div className="flex justify-end">
				<div className="max-w-[85%] rounded-2xl bg-zinc-900 px-4 py-3 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900">
					<p className="text-sm">{run.prompt || "No prompt"}</p>
					<p className="mt-2 text-[11px] opacity-70">
						You · {relativeTime(run.createdAt)}
					</p>
				</div>
			</div>

			<div className="flex justify-start">
				<div className="w-full max-w-[95%] rounded-2xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
					<div className="mb-2 flex items-center gap-2">
						<p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
							Flamecast
						</p>
						<RunStatusBadge run={run} />
					</div>

					<div className="mt-1 flex flex-col gap-2">
						{run.errorMessage ? (
							<p className="text-sm text-red-500 dark:text-red-400">
								{run.errorMessage}
							</p>
						) : run.errorAt ? (
							<p className="text-sm text-red-500 dark:text-red-400">
								The run failed before outputs were fully captured.
							</p>
						) : sourceRepo.length < 2 ? (
							<p className="text-sm text-zinc-500 dark:text-zinc-400">
								No source repository linked for this run.
							</p>
						) : outputsLoading ? (
							<p className="text-sm text-zinc-500 dark:text-zinc-400">
								Loading claude_logs...
							</p>
						) : outputsError ? (
							<p className="text-sm text-red-500 dark:text-red-400">
								Unable to load claude_logs: {outputsError.message}
							</p>
						) : outputs?.available && outputs.claudeLogs ? (
							<>
								<p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
									claude_logs
								</p>
								<pre className="max-h-[420px] overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900 p-3 text-xs text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap break-words">
									{outputs.claudeLogs}
								</pre>
								{outputs.claudeLogsTruncated && (
									<p className="text-xs text-zinc-500 dark:text-zinc-400">
										Showing first {MAX_CLAUDE_LOGS_CHARS.toLocaleString()}{" "}
										characters.
									</p>
								)}
							</>
						) : outputs?.available ? (
							<p className="text-sm text-zinc-500 dark:text-zinc-400">
								No claude_logs found in outputs.
							</p>
						) : (
							<p className="text-sm text-zinc-500 dark:text-zinc-400">
								{isRunning
									? "Waiting for outputs... The workflow is still running."
									: "No Flamecast outputs artifact found for this run."}
							</p>
						)}
					</div>

					<div className="mt-3 flex items-center gap-3 flex-wrap border-t border-zinc-200 pt-3 dark:border-zinc-800">
						{prUrl && (
							<a
								href={prUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
							>
								View PR
							</a>
						)}
						{runDetailUrl && (
							<Link
								to={runDetailUrl}
								className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
							>
								Run details
							</Link>
						)}
						{run.completedAt && run.sourceRepo && (() => {
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
					</div>
				</div>
			</div>
		</div>
	)
}

function FollowUpForm({
	chatId,
	owner,
	repo,
	workflowOwner,
	latestRun,
}: {
	chatId: string
	owner: string
	repo: string
	workflowOwner: string
	latestRun?: FlamecastWorkflowRun
}) {
	const [prompt, setPrompt] = useState("")
	const dispatch = useDispatchWorkflow()

	// Get the branch from the latest completed run for follow-up context
	const latestSourceRepo = latestRun?.sourceRepo?.split("/") ?? []
	const outputs = useFlamecastWorkflowRunOutputs(
		latestSourceRepo[0] ?? "",
		latestSourceRepo[1] ?? "",
		latestRun?.workflowRunId ?? 0,
	)

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		if (!prompt.trim()) return

		const baseBranch =
			latestRun?.completedAt && outputs.data?.branchName
				? outputs.data.branchName
				: undefined

		try {
			await dispatch.mutateAsync({
				owner: workflowOwner,
				repo: "flamecast",
				prompt: prompt.trim(),
				targetRepo: `${owner}/${repo}`,
				chatId,
				baseBranch,
			})

			posthog.capture("chat_followup_dispatched", {
				target_repo: `${owner}/${repo}`,
				prompt_length: prompt.trim().length,
				chat_id: chatId,
				has_base_branch: !!baseBranch,
			})

			setPrompt("")
		} catch (error) {
			posthog.captureException(error)
		}
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-3">
			<Textarea
				placeholder="Send a follow-up prompt..."
				value={prompt}
				onChange={e => setPrompt(e.target.value)}
				rows={3}
			/>
			{dispatch.error && (
				<p className="text-sm text-red-500">{dispatch.error.message}</p>
			)}
			{dispatch.isSuccess && (
				<p className="text-sm text-green-600 dark:text-green-400">
					Follow-up dispatched successfully
				</p>
			)}
			<Button
				type="submit"
				disabled={dispatch.isPending || !prompt.trim()}
				className="w-fit"
			>
				{dispatch.isPending ? "Dispatching..." : "Send Follow-up"}
			</Button>
		</form>
	)
}

export function ChatDetail({
	chatId,
	owner,
	repo,
	workflowOwner,
}: {
	chatId: string
	owner: string
	repo: string
	workflowOwner: string
}) {
	const { data: chat, isLoading, error } = useChat(chatId)
	const updateTitle = useUpdateChatTitle()
	const [isEditingTitle, setIsEditingTitle] = useState(false)
	const [editTitle, setEditTitle] = useState("")

	if (isLoading) {
		return <p className="text-sm text-zinc-400">Loading chat...</p>
	}

	if (error || !chat) {
		return (
			<p className="text-sm text-red-500">
				{error?.message || "Chat not found"}
			</p>
		)
	}

	const latestRun =
		chat.runs.length > 0 ? chat.runs[chat.runs.length - 1] : undefined

	return (
		<div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
			<main className="flex min-h-screen w-full max-w-3xl flex-col gap-6 py-16 px-8 bg-white dark:bg-black">
				{/* Breadcrumb */}
				<div className="flex items-center gap-3">
					<Link
						to="/"
						className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
					>
						Flamecast
					</Link>
					<span className="text-zinc-300 dark:text-zinc-600">/</span>
					<Link
						to={`/${owner}/${repo}`}
						className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
					>
						{owner}/{repo}
					</Link>
					<span className="text-zinc-300 dark:text-zinc-600">/</span>
					{isEditingTitle ? (
						<form
							onSubmit={e => {
								e.preventDefault()
								if (editTitle.trim()) {
									updateTitle.mutate({
										chatId,
										title: editTitle.trim(),
									})
								}
								setIsEditingTitle(false)
							}}
							className="flex items-center gap-2"
						>
							<input
								type="text"
								value={editTitle}
								onChange={e => setEditTitle(e.target.value)}
								className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50 bg-transparent border-b border-zinc-300 dark:border-zinc-600 outline-none"
								autoFocus
								onBlur={() => setIsEditingTitle(false)}
							/>
						</form>
					) : (
						<h1
							className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50 cursor-pointer hover:opacity-80"
							onClick={() => {
								setEditTitle(chat.title)
								setIsEditingTitle(true)
							}}
							title="Click to edit title"
						>
							{chat.title}
						</h1>
					)}
				</div>

				{/* Conversation thread */}
				<div className="flex flex-col gap-4">
					{chat.runs.map(run => (
						<RunMessage key={run.id} run={run} />
					))}

					{chat.runs.length === 0 && (
						<p className="text-sm text-zinc-500 dark:text-zinc-400">
							No workflow runs in this chat yet.
						</p>
					)}
				</div>

				{/* Follow-up form */}
				<FollowUpForm
					chatId={chatId}
					owner={owner}
					repo={repo}
					workflowOwner={workflowOwner}
					latestRun={latestRun}
				/>
			</main>
		</div>
	)
}
