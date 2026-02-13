"use client"

import { useState } from "react"
import posthog from "posthog-js"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useDispatchWorkflow } from "@/hooks/use-api"

export function WorkflowTriggerForm({
	owner,
	repo,
	workflowOwner,
}: {
	owner: string
	repo: string
	workflowOwner: string
}) {
	const [prompt, setPrompt] = useState("")
	const dispatch = useDispatchWorkflow()

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		if (!prompt.trim()) return

		try {
			await dispatch.mutateAsync({
				owner: workflowOwner,
				repo: "flamecast",
				prompt: prompt.trim(),
				targetRepo: `${owner}/${repo}`,
			})

			posthog.capture("workflow_dispatched", {
				target_repo: `${owner}/${repo}`,
				prompt_length: prompt.trim().length,
			})

			setPrompt("")
		} catch (error) {
			posthog.captureException(error)
		}
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-3">
			<Textarea
				placeholder="Describe what you want Flamecast to do..."
				value={prompt}
				onChange={e => setPrompt(e.target.value)}
				rows={3}
			/>
			{dispatch.error && (
				<p className="text-sm text-red-500">{dispatch.error.message}</p>
			)}
			{dispatch.isSuccess && (
				<p className="text-sm text-green-600 dark:text-green-400">
					Workflow dispatched successfully
				</p>
			)}
			<Button
				type="submit"
				disabled={dispatch.isPending || !prompt.trim()}
				className="w-fit"
			>
				{dispatch.isPending ? "Dispatching..." : "Run Flamecast"}
			</Button>
		</form>
	)
}
