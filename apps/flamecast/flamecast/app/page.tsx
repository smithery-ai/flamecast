import {
	getSignInUrl,
	getSignUpUrl,
	signOut,
	withAuth,
} from "@workos-inc/authkit-nextjs"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"
import { getPostHogClient } from "@/lib/posthog-server"
import Link from "next/link"
import { WorkflowRunsList } from "@/components/workflow-runs-list"

export default async function Home() {
	const { user } = await withAuth()
	const signInUrl = await getSignInUrl()
	const signUpUrl = await getSignUpUrl()

	let repos: Array<{
		name: string
		full_name: string
		owner: { login: string }
		description: string | null
		private: boolean
		language: string | null
		updated_at: string | null
	}> = []

	if (user) {
		const creds = await getGitHubCredentials()
		if (creds) {
			const octokit = createOctokit(creds.accessToken)
			const { data } = await octokit.rest.repos.listForAuthenticatedUser({
				sort: "updated",
				per_page: 30,
				type: "all",
			})
			repos = data
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
			<main className="flex min-h-screen w-full max-w-3xl flex-col gap-8 py-16 px-8 bg-white dark:bg-black">
				<div className="flex items-center justify-between">
					<h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
						Flamecast
					</h1>
					{user && (
						<div className="flex items-center gap-4">
							<Link
								href="/settings"
								className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
							>
								Settings
							</Link>
							<form
								action={async () => {
									"use server"
									const { user } = await withAuth()
									if (user) {
										const posthog = getPostHogClient()
										posthog.capture({
											distinctId: user.id,
											event: "user_signed_out",
										})
									}
									await signOut()
								}}
							>
								<button
									type="submit"
									className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
								>
									Sign Out
								</button>
							</form>
						</div>
					)}
				</div>

				{user ? (
					<>
						{repos.length > 0 ? (
							<div className="flex flex-col gap-1">
								{repos.map(repo => (
									<Link
										key={repo.full_name}
										href={`/${repo.owner.login}/${repo.name}`}
										className="flex items-center justify-between rounded-lg px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors group"
									>
										<div className="flex flex-col gap-1 min-w-0">
											<div className="flex items-center gap-2">
												<span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
													{repo.full_name}
												</span>
												{repo.private && (
													<span className="shrink-0 text-xs px-1.5 py-0.5 rounded-full border border-zinc-200 dark:border-zinc-700 text-zinc-500">
														private
													</span>
												)}
											</div>
											{repo.description && (
												<p className="text-sm text-zinc-500 dark:text-zinc-400 truncate">
													{repo.description}
												</p>
											)}
										</div>
										{repo.language && (
											<span className="shrink-0 ml-4 text-xs text-zinc-400">
												{repo.language}
											</span>
										)}
									</Link>
								))}
							</div>
						) : (
							<p className="text-zinc-500 dark:text-zinc-400">
								No repositories found. Make sure your GitHub account is
								connected.
							</p>
						)}

						<div className="flex flex-col gap-3">
							<h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
								Recent Runs
							</h2>
							<WorkflowRunsList />
						</div>
					</>
				) : (
					<div className="flex flex-col gap-6">
						<p className="text-lg text-zinc-600 dark:text-zinc-400">
							Sign in to get started
						</p>
						<div className="flex flex-col gap-4 text-base font-medium sm:flex-row">
							<a
								href={signInUrl}
								className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-foreground px-5 text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc] md:w-[158px]"
							>
								Sign In
							</a>
							<a
								href={signUpUrl}
								className="flex h-12 w-full items-center justify-center rounded-full border border-solid border-black/[.08] px-5 transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a] md:w-[158px]"
							>
								Sign Up
							</a>
						</div>
					</div>
				)}
			</main>
		</div>
	)
}
