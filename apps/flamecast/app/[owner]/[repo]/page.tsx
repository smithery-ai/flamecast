import { redirect } from "next/navigation"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"
import Link from "next/link"
import { WorkflowTriggerForm } from "@/components/workflow-trigger-form"
import { ChatList } from "@/components/chat-list"

export default async function RepoPage({
	params,
}: {
	params: Promise<{ owner: string; repo: string }>
}) {
	const creds = await getGitHubCredentials()
	if (!creds) redirect("/")

	const { owner, repo } = await params
	const octokit = createOctokit(creds.accessToken)

	const [{ data: ghUser }, { data: pulls }] = await Promise.all([
		octokit.rest.users.getAuthenticated(),
		octokit.rest.pulls.list({
			owner,
			repo,
			state: "open",
			per_page: 100,
		}),
	])

	const flamecastPRs = pulls.filter(pr => pr.head.ref.startsWith("flamecast/"))

	return (
		<div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
			<main className="flex min-h-screen w-full max-w-3xl flex-col gap-8 py-16 px-8 bg-white dark:bg-black">
				<div className="flex items-center gap-3">
					<Link
						href="/"
						className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
					>
						Flamecast
					</Link>
					<span className="text-zinc-300 dark:text-zinc-600">/</span>
					<h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
						{owner}/{repo}
					</h1>
				</div>

				<WorkflowTriggerForm
					owner={owner}
					repo={repo}
					workflowOwner={ghUser.login}
				/>

				<ChatList repo={`${owner}/${repo}`} owner={owner} repoName={repo} />

				{flamecastPRs.length > 0 ? (
					<div className="flex flex-col gap-1">
						{flamecastPRs.map(pr => (
							<a
								key={pr.number}
								href={pr.html_url}
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center justify-between rounded-lg px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
							>
								<div className="flex flex-col gap-1 min-w-0">
									<div className="flex items-center gap-2">
										<span className="text-sm text-zinc-400">#{pr.number}</span>
										<span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
											{pr.title}
										</span>
									</div>
									<p className="text-xs text-zinc-400 truncate">
										{pr.head.ref}
									</p>
								</div>
								<span className="shrink-0 ml-4 text-xs text-zinc-400">
									{new Date(pr.created_at).toLocaleDateString()}
								</span>
							</a>
						))}
					</div>
				) : (
					<p className="text-zinc-500 dark:text-zinc-400">
						No open flamecast PRs found.
					</p>
				)}
			</main>
		</div>
	)
}
