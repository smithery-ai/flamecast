"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
	usePullRequestStatus,
	useMergePull,
	useClosePull,
} from "@/hooks/use-api"
import { queryKeys } from "@/hooks/query-keys"
import { Button } from "@/components/ui/button"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

function parsePrUrl(
	url: string,
): { owner: string; repo: string; number: number } | null {
	const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
	if (!match) return null
	return { owner: match[1], repo: match[2], number: Number(match[3]) }
}

function CheckIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			width="12"
			height="12"
			viewBox="0 0 12 12"
			fill="none"
		>
			<path
				d="M10 3L4.5 8.5L2 6"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	)
}

function XIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			width="12"
			height="12"
			viewBox="0 0 12 12"
			fill="none"
		>
			<path
				d="M9 3L3 9M3 3L9 9"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	)
}

function DotIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			width="12"
			height="12"
			viewBox="0 0 12 12"
			fill="none"
		>
			<circle cx="6" cy="6" r="3" fill="currentColor" />
		</svg>
	)
}

interface PullRequestActionsProps {
	prUrl: string
}

export function PullRequestActions({ prUrl }: PullRequestActionsProps) {
	const parsed = parsePrUrl(prUrl)
	const queryClient = useQueryClient()
	const [showAllChecks, setShowAllChecks] = useState(false)

	const [pollInterval, setPollInterval] = useState<number | false>(10_000)

	const { data: status, isLoading: statusLoading } = usePullRequestStatus(
		parsed?.owner ?? "",
		parsed?.repo ?? "",
		parsed?.number ?? 0,
		{
			enabled: !!parsed,
			refetchInterval: pollInterval,
		},
	)

	// Stop polling when checks are done and PR is mergeable, or PR is no longer open
	if (
		status &&
		pollInterval !== false &&
		(status.state !== "open" ||
			(status.checks.pending === 0 && status.mergeable))
	) {
		setPollInterval(false)
	}

	const mergePull = useMergePull()
	const closePull = useClosePull()

	if (!parsed) {
		return (
			<a
				href={prUrl}
				target="_blank"
				rel="noopener noreferrer"
				className="text-blue-600 dark:text-blue-400 hover:underline"
			>
				{prUrl}
			</a>
		)
	}

	const { owner, repo, number } = parsed

	const invalidateStatus = () => {
		queryClient.invalidateQueries({
			queryKey: queryKeys.pullRequestStatus(owner, repo, number),
		})
		queryClient.invalidateQueries({
			queryKey: queryKeys.pulls(owner, repo),
		})
	}

	const canMerge =
		status?.state === "open" &&
		status.mergeable &&
		status.checks.failed === 0 &&
		status.checks.pending === 0

	const isOpen = status?.state === "open"
	const isMerging = mergePull.isPending
	const isClosing = closePull.isPending

	const checksToShow = showAllChecks
		? (status?.checkRuns ?? [])
		: (status?.checkRuns ?? []).slice(0, 5)
	const hasMoreChecks = (status?.checkRuns?.length ?? 0) > 5

	return (
		<div className="flex flex-col gap-3">
			<a
				href={prUrl}
				target="_blank"
				rel="noopener noreferrer"
				className="text-blue-600 dark:text-blue-400 hover:underline break-all"
			>
				{prUrl}
			</a>

			{statusLoading ? (
				<p className="text-xs text-zinc-500 dark:text-zinc-400">
					Loading PR status...
				</p>
			) : status ? (
				<>
					{status.state === "merged" && (
						<span className="inline-flex w-fit items-center rounded-full bg-purple-100 dark:bg-purple-900/30 px-2.5 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
							Merged
						</span>
					)}

					{status.state === "closed" && (
						<span className="inline-flex w-fit items-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
							Closed
						</span>
					)}

					{isOpen && (
						<>
							{status.checks.total > 0 && (
								<div className="flex flex-col gap-2">
									<p className="text-xs text-zinc-600 dark:text-zinc-300">
										{status.checks.completed}/{status.checks.total} checks
										complete
										{status.checks.failed > 0 && (
											<span className="text-red-600 dark:text-red-400">
												{" "}
												({status.checks.failed} failed)
											</span>
										)}
									</p>
									<div className="flex flex-col gap-1">
										{checksToShow.map(cr => (
											<div
												key={cr.id}
												className="flex items-center gap-1.5 text-xs"
											>
												{cr.status === "completed" ? (
													cr.conclusion === "success" ? (
														<CheckIcon className="text-green-600 dark:text-green-400" />
													) : (
														<XIcon className="text-red-600 dark:text-red-400" />
													)
												) : (
													<DotIcon className="text-yellow-600 dark:text-yellow-400 animate-pulse" />
												)}
												<span className="text-zinc-600 dark:text-zinc-400">
													{cr.name}
												</span>
											</div>
										))}
										{hasMoreChecks && !showAllChecks && (
											<button
												type="button"
												onClick={() => setShowAllChecks(true)}
												className="text-xs text-blue-600 dark:text-blue-400 hover:underline text-left"
											>
												Show all {status.checkRuns.length} checks
											</button>
										)}
									</div>
								</div>
							)}

							{status.checks.total === 0 && (
								<p className="text-xs text-zinc-500 dark:text-zinc-400">
									No checks found
								</p>
							)}

							<div className="flex items-center gap-2 pt-1">
								<AlertDialog>
									<AlertDialogTrigger asChild>
										<Button size="sm" disabled={!canMerge || isMerging}>
											{isMerging ? "Merging..." : "Merge"}
										</Button>
									</AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>Merge pull request</AlertDialogTitle>
											<AlertDialogDescription>
												This will squash and merge PR #{number} and delete the
												branch. This action cannot be undone.
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>Cancel</AlertDialogCancel>
											<AlertDialogAction
												onClick={() => {
													mergePull.mutate(
														{ owner, repo, number },
														{ onSuccess: invalidateStatus },
													)
												}}
											>
												Merge
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>

								<AlertDialog>
									<AlertDialogTrigger asChild>
										<Button size="sm" variant="outline" disabled={isClosing}>
											{isClosing ? "Closing..." : "Close PR"}
										</Button>
									</AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>Close pull request</AlertDialogTitle>
											<AlertDialogDescription>
												This will close PR #{number} and delete the branch.
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>Cancel</AlertDialogCancel>
											<AlertDialogAction
												variant="destructive"
												onClick={() => {
													closePull.mutate(
														{ owner, repo, number },
														{ onSuccess: invalidateStatus },
													)
												}}
											>
												Close
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
							</div>

							{mergePull.isError && (
								<p className="text-xs text-red-600 dark:text-red-400">
									Merge failed:{" "}
									{mergePull.error instanceof Error
										? mergePull.error.message
										: "Unknown error"}
								</p>
							)}
							{closePull.isError && (
								<p className="text-xs text-red-600 dark:text-red-400">
									Close failed:{" "}
									{closePull.error instanceof Error
										? closePull.error.message
										: "Unknown error"}
								</p>
							)}
						</>
					)}
				</>
			) : null}
		</div>
	)
}
