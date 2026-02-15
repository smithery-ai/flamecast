import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useUser } from '@/hooks/useUser'
import { ChatDetail } from '@/components/chat-detail'
import { getGitHubAuthenticatedUser } from '@/lib/actions'

export const Route = createFileRoute('/$owner/$repo/chat/$chatId')({
  ssr: false,
  component: ChatPage,
})

function ChatPage() {
  useUser()
  const { owner, repo, chatId } = Route.useParams()

  const userQuery = useQuery({
    queryKey: ['github', 'user'],
    queryFn: () => getGitHubAuthenticatedUser(),
  })

  if (userQuery.isLoading || !userQuery.data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
        <main className="flex min-h-screen w-full max-w-3xl flex-col gap-8 py-16 px-8 bg-white dark:bg-black">
          <p className="text-zinc-500 dark:text-zinc-400">Loading...</p>
        </main>
      </div>
    )
  }

  return (
    <ChatDetail
      chatId={chatId}
      owner={owner}
      repo={repo}
      workflowOwner={userQuery.data.login}
    />
  )
}
