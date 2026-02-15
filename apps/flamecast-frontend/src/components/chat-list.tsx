"use client"

import { useState } from "react"
import {
	useChats,
	useArchiveChat,
	useUnarchiveChat,
	type FlamecastChat,
} from "@/hooks/use-api"

function statusDotClass(
	status: "running" | "completed" | "error" | "queued" | null | undefined,
) {
	switch (status) {
		case "completed":
			return "bg-green-500"
		case "error":
			return "bg-red-500"
		case "queued":
			return "bg-blue-400"
		case "running":
			return "bg-amber-500 animate-pulse"
		default:
			return "bg-zinc-300 dark:bg-zinc-600"
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

export function ChatList({
	repo,
	owner,
	repoName,
}: {
	repo: string
	owner: string
	repoName: string
}) {
	const [showArchived, setShowArchived] = useState(false)
	const {
		data,
		isLoading,
		error,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useChats(repo, {
		refetchInterval: 5000,
		includeArchived: showArchived,
	})
	const archive = useArchiveChat()
	const unarchive = useUnarchiveChat()

	const chats = (data?.pages ?? []).flatMap(page =>
		Array.isArray(page?.chats) ? page.chats : [],
	)

	if (isLoading) {
		return <p className="text-sm text-zinc-400">Loading chats...</p>
	}

	if (error) {
		return null
	}

	if (chats.length === 0) {
		return (
			<p className="text-sm text-zinc-500 dark:text-zinc-400">
				No chats yet. Send a prompt to get started.
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
			{chats.map(chat => {
				const isArchived = !!chat.archivedAt
				return (
					<div
						key={chat.id}
						onClick={() =>
							window.location.assign(
								`/${owner}/${repoName}/chat/${chat.id}`,
							)
						}
						onKeyDown={e => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault()
								window.location.assign(
									`/${owner}/${repoName}/chat/${chat.id}`,
								)
							}
						}}
						className={`group flex items-center justify-between rounded-lg px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors cursor-pointer ${
							isArchived ? "opacity-50" : ""
						}`}
						role="link"
						tabIndex={0}
					>
						<div className="flex items-center gap-3 min-w-0">
							<span
								className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDotClass(chat.latestRunStatus)}`}
							/>
							<div className="flex flex-col gap-0.5 min-w-0">
								<p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
									{chat.title}
								</p>
								{chat.lastPrompt && chat.lastPrompt !== chat.title && (
									<p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
										{chat.lastPrompt}
									</p>
								)}
								{chat.runCount !== undefined && chat.runCount > 1 && (
									<p className="text-xs text-zinc-400">
										{chat.runCount} runs
									</p>
								)}
							</div>
						</div>
						<div className="shrink-0 ml-4 flex items-center gap-3">
							<span className="text-xs text-zinc-400">
								{relativeTime(chat.updatedAt)}
							</span>
							{isArchived ? (
								<button
									type="button"
									onClick={event => {
										event.stopPropagation()
										unarchive.mutate({ chatId: chat.id, repo })
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
										archive.mutate({ chatId: chat.id, repo })
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
