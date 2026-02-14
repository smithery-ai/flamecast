"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
	useFlamecastWorkflowRunOutputs,
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

interface InlinePRActionsProps {
	sourceOwner: string
	sourceRepo: string
	runId: number
}

export function InlinePRActions({ sourceOwner, sourceRepo, runId }: InlinePRActionsProps) {
	const { data: outputs } = useFlamecastWorkflowRunOutputs(
		sourceOwner,
		sourceRepo,
		runId,
	)

	if (!outputs?.prUrl) return null

	return <InlinePRActionsInner prUrl={outputs.prUrl} />
}

function InlinePRActionsInner({ prUrl }: { prUrl: string }) {
	const parsed = parsePrUrl(prUrl)
	const queryClient = useQueryClient()
	const [pollInterval, setPollInterval] = useState<number | false>(10_000)

	const { data: status, isLoading } = usePullRequestStatus(
		parsed?.owner ?? "",
		parsed?.repo ?? "",
		parsed?.number ?? 0,
		{
			enabled: !!parsed,
			refetchInterval: pollInterval,
		},
	)

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

	if (!parsed) return null

	const { owner, repo, number } = parsed

	const invalidateStatus = () => {
		queryClient.invalidateQueries({
			queryKey: queryKeys.pullRequestStatus(owner, repo, number),
		})
		queryClient.invalidateQueries({
			queryKey: queryKeys.pulls(owner, repo),
		})
	}

	if (isLoading) {
		return (
			<span className="text-xs text-zinc-400">Loading...</span>
		)
	}

	if (!status) return null

	if (status.state === "merged") {
		return (
			<span className="inline-flex items-center rounded-full bg-purple-100 dark:bg-purple-900/30 px-2 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
				Merged
			</span>
		)
	}

	if (status.state === "closed") {
		return (
			<span className="inline-flex items-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
				Closed
			</span>
		)
	}

	const canMerge =
		status.mergeable &&
		status.checks.failed === 0 &&
		status.checks.pending === 0

	const isMerging = mergePull.isPending
	const isClosing = closePull.isPending

	return (
		<div
			className="flex items-center gap-1.5"
			onClick={e => e.stopPropagation()}
			onKeyDown={e => e.stopPropagation()}
		>
			{status.checks.total > 0 && (
				status.checks.pending > 0 ? (
					<span className="text-xs text-zinc-400">
						{status.checks.completed}/{status.checks.total}
					</span>
				) : status.checks.failed > 0 ? (
					<span className="flex items-center gap-0.5 text-xs text-red-500">
						{status.checks.failed}
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
							<path d="M9 3L3 9M3 3L9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
						</svg>
					</span>
				) : (
					<span className="text-xs text-green-600 dark:text-green-400">
						{status.checks.successful}/{status.checks.total}
					</span>
				)
			)}

			<AlertDialog>
				<AlertDialogTrigger asChild>
					<Button
						size="sm"
						className="h-6 px-2 text-xs"
						disabled={!canMerge || isMerging}
					>
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
					<Button
						size="sm"
						variant="outline"
						className="h-6 px-2 text-xs"
						disabled={isClosing}
					>
						{isClosing ? "Closing..." : "Close"}
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
	)
}
