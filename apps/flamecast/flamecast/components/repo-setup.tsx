"use client"

import { useState } from "react"
import posthog from "posthog-js"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
	useSetupStatus,
	useCreateRepo,
	useSaveSecrets,
	useUpdateWorkflow,
} from "@/hooks/use-api"

export function RepoSetup() {
	const [claudeToken, setClaudeToken] = useState("")
	const [flamecastPat, setFlamecastPat] = useState("")

	const {
		data: status,
		isLoading: loading,
		error: statusError,
	} = useSetupStatus()
	const createRepo = useCreateRepo()
	const saveSecrets = useSaveSecrets()
	const updateWorkflow = useUpdateWorkflow()

	const error =
		createRepo.error?.message ??
		saveSecrets.error?.message ??
		updateWorkflow.error?.message ??
		(statusError ? "Failed to load setup status" : null)

	function handleCreateRepo() {
		createRepo.mutate(undefined, {
			onSuccess: () => {
				posthog.capture("repo_created")
			},
			onError: error => {
				posthog.captureException(error)
			},
		})
	}

	function handleUpdateWorkflow() {
		updateWorkflow.mutate(undefined, {
			onSuccess: () => {
				posthog.capture("workflow_updated")
			},
			onError: error => {
				posthog.captureException(error)
			},
		})
	}

	function handleSaveSecrets() {
		if (!status) return
		const secrets: Record<string, string> = {}
		if (claudeToken) secrets.CLAUDE_CODE_OAUTH_TOKEN = claudeToken
		if (flamecastPat) secrets.FLAMECAST_PAT = flamecastPat

		if (Object.keys(secrets).length === 0) return

		const secretNames = Object.keys(secrets)

		saveSecrets.mutate(
			{ repo: `${status.username}/flamecast`, secrets },
			{
				onSuccess: () => {
					setClaudeToken("")
					setFlamecastPat("")
					posthog.capture("secrets_saved", {
						secret_count: secretNames.length,
						has_claude_token: secretNames.includes("CLAUDE_CODE_OAUTH_TOKEN"),
						has_flamecast_pat: secretNames.includes("FLAMECAST_PAT"),
					})
				},
				onError: error => {
					posthog.captureException(error)
				},
			},
		)
	}

	if (loading) {
		return (
			<p className="text-zinc-500 dark:text-zinc-400">
				Loading setup status...
			</p>
		)
	}

	if (!status) {
		return (
			<p className="text-red-500">{error || "Failed to load setup status"}</p>
		)
	}

	return (
		<div className="flex flex-col gap-8">
			{error && <p className="text-sm text-red-500">{error}</p>}

			{/* Repository Section */}
			<section className="flex flex-col gap-3">
				<h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
					Repository
				</h2>
				{status.repoExists ? (
					<div className="flex flex-col gap-3">
						<div className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 px-4 py-3">
							<svg
								className="h-4 w-4 text-green-500 shrink-0"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								strokeWidth={2}
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									d="M5 13l4 4L19 7"
								/>
							</svg>
							<a
								href={`https://github.com/${status.username}/flamecast`}
								target="_blank"
								rel="noopener noreferrer"
								className="text-sm text-zinc-700 dark:text-zinc-300 hover:underline"
							>
								{status.username}/flamecast
							</a>
						</div>
						<div className="flex flex-col gap-2">
							<p className="text-sm text-zinc-500 dark:text-zinc-400">
								Update the workflow to the latest version and set up status
								tracking. This saves an API key as a GitHub secret and opens a
								PR to update{" "}
								<code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">
									.github/workflows/flamecast.yml
								</code>
								.
							</p>
							<div className="flex items-center gap-3">
								<Button
									onClick={handleUpdateWorkflow}
									disabled={updateWorkflow.isPending}
									className="w-fit"
								>
									{updateWorkflow.isPending ? "Updating..." : "Update Workflow"}
								</Button>
								{updateWorkflow.data?.prUrl && (
									<a
										href={updateWorkflow.data.prUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="text-sm text-zinc-700 dark:text-zinc-300 hover:underline"
									>
										Open PR
									</a>
								)}
							</div>
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						<p className="text-sm text-zinc-500 dark:text-zinc-400">
							Create a repository to store the Flamecast workflow and secrets.
						</p>
						<Button
							onClick={handleCreateRepo}
							disabled={createRepo.isPending}
							className="w-fit"
						>
							{createRepo.isPending
								? "Creating..."
								: `Create ${status.username}/flamecast`}
						</Button>
					</div>
				)}
			</section>

			{/* Secrets Section */}
			{status.repoExists && (
				<section className="flex flex-col gap-4">
					<div className="flex flex-col gap-1">
						<h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
							Secrets
						</h2>
						<p className="text-sm text-zinc-500 dark:text-zinc-400">
							These are stored as encrypted secrets on your GitHub repository.
							We never store them on our servers.
						</p>
					</div>

					<div className="flex flex-col gap-1">
						<div className="flex items-center gap-2">
							<label
								htmlFor="claude-token"
								className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
							>
								CLAUDE_CODE_OAUTH_TOKEN
							</label>
							{status.hasClaudeToken && (
								<span className="text-xs text-green-600 dark:text-green-400">
									Set
								</span>
							)}
						</div>
						<p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
							Run{" "}
							<code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">
								claude setup-token
							</code>{" "}
							in your terminal to generate this token.
						</p>
						<Input
							id="claude-token"
							type="password"
							placeholder={
								status.hasClaudeToken
									? "Enter new value to update..."
									: "Enter token..."
							}
							value={claudeToken}
							onChange={e => setClaudeToken(e.target.value)}
						/>
					</div>

					<div className="flex flex-col gap-1">
						<div className="flex items-center gap-2">
							<label
								htmlFor="flamecast-pat"
								className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
							>
								FLAMECAST_PAT
							</label>
							{status.hasFlamecastPat && (
								<span className="text-xs text-green-600 dark:text-green-400">
									Set
								</span>
							)}
						</div>
						<p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
							GitHub Personal Access Token with{" "}
							<code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">
								repo
							</code>{" "}
							scope.{" "}
							<a
								href="https://github.com/settings/tokens/new"
								target="_blank"
								rel="noopener noreferrer"
								className="text-zinc-600 dark:text-zinc-300 underline hover:text-zinc-900 dark:hover:text-zinc-100"
							>
								Create one here
							</a>
							.
						</p>
						<Input
							id="flamecast-pat"
							type="password"
							placeholder={
								status.hasFlamecastPat
									? "Enter new value to update..."
									: "ghp_..."
							}
							value={flamecastPat}
							onChange={e => setFlamecastPat(e.target.value)}
						/>
					</div>

					<Button
						onClick={handleSaveSecrets}
						disabled={saveSecrets.isPending || (!claudeToken && !flamecastPat)}
						className="w-fit"
					>
						{saveSecrets.isPending ? "Saving..." : "Save Secrets"}
					</Button>
				</section>
			)}
		</div>
	)
}
