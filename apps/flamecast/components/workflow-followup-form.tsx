"use client"

import { useState } from "react"
import posthog from "posthog-js"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useDispatchFollowupWorkflow } from "@/hooks/use-api"

export function WorkflowFollowupForm({
	owner,
	repo,
	runId,
	targetRepo,
}: {
	owner: string
	repo: string
	runId: number
	targetRepo?: string
}) {
	const [followupPrompt, setFollowupPrompt] = useState("")
	const dispatch = useDispatchFollowupWorkflow()

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		if (!followupPrompt.trim()) return

		try {
			await dispatch.mutateAsync({
				owner,
				repo,
				parentRunId: runId,
				followupPrompt: followupPrompt.trim(),
				targetRepo,
			})

			posthog.capture("workflow_followup_dispatched", {
				parent_run_id: runId,
				target_repo: targetRepo || `${owner}/${repo}`,
				followup_length: followupPrompt.trim().length,
			})

			setFollowupPrompt("")
		} catch (error) {
			posthog.captureException(error)
		}
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-3">
			<h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
				Add Follow-up
			</h2>
			<p className="text-sm text-zinc-600 dark:text-zinc-400">
				Submit a follow-up prompt to continue working on this task. The new
				workflow will include the original prompt and Claude's output as
				context.
			</p>
			<Textarea
				placeholder="Describe what you want Flamecast to do next..."
				value={followupPrompt}
				onChange={e => setFollowupPrompt(e.target.value)}
				rows={3}
			/>
			{dispatch.error && (
				<p className="text-sm text-red-500">{dispatch.error.message}</p>
			)}
			{dispatch.isSuccess && (
				<p className="text-sm text-green-600 dark:text-green-400">
					Follow-up workflow dispatched successfully
				</p>
			)}
			<Button
				type="submit"
				disabled={dispatch.isPending || !followupPrompt.trim()}
				className="w-fit"
			>
				{dispatch.isPending ? "Dispatching..." : "Run Follow-up"}
			</Button>
		</form>
	)
}
