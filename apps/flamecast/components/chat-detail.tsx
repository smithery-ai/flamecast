"use client"

import { useState } from "react"
import Link from "next/link"
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

	return (
		<div className="flex flex-col gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
			{/* User prompt */}
			<div className="flex items-start justify-between gap-3">
				<p className="text-sm text-zinc-900 dark:text-zinc-100">
					{run.prompt || "No prompt"}
				</p>
				<span className="shrink-0 text-xs text-zinc-400">
					{relativeTime(run.createdAt)}
				</span>
			</div>

			{/* Status and result */}
			<div className="flex items-center gap-3 flex-wrap">
				<RunStatusBadge run={run} />
				{run.prUrl && (
					<a
						href={run.prUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
					>
						View PR
					</a>
				)}
				{runDetailUrl && (
					<Link
						href={runDetailUrl}
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

			{run.errorMessage && (
				<p className="text-xs text-red-500 dark:text-red-400">
					{run.errorMessage}
				</p>
			)}
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
						href="/"
						className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
					>
						Flamecast
					</Link>
					<span className="text-zinc-300 dark:text-zinc-600">/</span>
					<Link
						href={`/${owner}/${repo}`}
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
