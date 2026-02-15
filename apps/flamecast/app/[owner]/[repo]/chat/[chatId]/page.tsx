import { redirect } from "next/navigation"
import { getGitHubCredentials } from "@/lib/auth"
import { createOctokit } from "@/lib/github"
import { ChatDetail } from "@/components/chat-detail"

export default async function ChatPage({
	params,
}: {
	params: Promise<{ owner: string; repo: string; chatId: string }>
}) {
	const creds = await getGitHubCredentials()
	if (!creds) redirect("/")

	const { owner, repo, chatId } = await params
	const octokit = createOctokit(creds.accessToken)
	const { data: ghUser } = await octokit.rest.users.getAuthenticated()

	return (
		<ChatDetail
			chatId={chatId}
			owner={owner}
			repo={repo}
			workflowOwner={ghUser.login}
		/>
	)
}
