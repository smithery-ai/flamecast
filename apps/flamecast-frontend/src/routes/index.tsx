import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import posthog from 'posthog-js'
import { WorkflowRunsList } from '@/components/workflow-runs-list'
import { listGitHubUserRepositories } from '@/lib/actions'
import {
  redirectToBackendLogin,
  redirectToBackendLogout,
} from '@/lib/backend-auth'
import { useAuthSession } from '@/hooks/useUser'

export const Route = createFileRoute('/')({
  ssr: false,
  component: HomePage,
})

function HomePage() {
  const { data: user, isLoading } = useAuthSession()

  const reposQuery = useQuery({
    queryKey: ['github', 'user', 'repos'],
    queryFn: () => listGitHubUserRepositories(),
    enabled: !!user,
  })

  function handleSignOut() {
    if (user) {
      posthog.capture('user_signed_out', {
        user_id: user.id,
      })
    }

    const returnTo =
      typeof window !== 'undefined' ? `${window.location.origin}/` : '/'
    redirectToBackendLogout(returnTo)
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
        <main className="flex min-h-screen w-full max-w-3xl flex-col gap-8 py-16 px-8 bg-white dark:bg-black">
          <p className="text-zinc-500 dark:text-zinc-400">Loading...</p>
        </main>
      </div>
    )
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
                to="/settings"
                className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
              >
                Settings
              </Link>
              <button
                type="button"
                onClick={handleSignOut}
                className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
              >
                Sign Out
              </button>
            </div>
          )}
        </div>

        {user ? (
          <>
            {reposQuery.isLoading ? (
              <p className="text-zinc-500 dark:text-zinc-400">Loading repositories...</p>
            ) : reposQuery.error ? (
              <p className="text-zinc-500 dark:text-zinc-400">
                Unable to load repositories. Confirm your GitHub account is connected.
              </p>
            ) : reposQuery.data && reposQuery.data.length > 0 ? (
              <div className="flex flex-col gap-1">
                {reposQuery.data.map((repo) => (
                  <Link
                    key={repo.full_name}
                    to={`/${repo.owner.login}/${repo.name}`}
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
                No repositories found. Make sure your GitHub account is connected.
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
              <button
                type="button"
                onClick={() => {
                  const returnTo =
                    typeof window !== 'undefined' ? window.location.href : '/'
                  redirectToBackendLogin(returnTo)
                }}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-foreground px-5 text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc] md:w-[158px]"
              >
                Sign In
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
