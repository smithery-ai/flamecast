import { createFileRoute, Link } from '@tanstack/react-router'
import { useUser } from '@/hooks/useUser'
import { RepoSetup } from '@/components/repo-setup'
import { ApiKeyManagement } from '@/components/api-key-management'

export const Route = createFileRoute('/settings')({
  ssr: false,
  component: SettingsPage,
})

function SettingsPage() {
  const user = useUser()

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
        <main className="flex min-h-screen w-full max-w-3xl flex-col gap-8 py-16 px-8 bg-white dark:bg-black">
          <p className="text-zinc-500 dark:text-zinc-400">Redirecting to sign in...</p>
        </main>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex min-h-screen w-full max-w-3xl flex-col gap-8 py-16 px-8 bg-white dark:bg-black">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
          >
            Flamecast
          </Link>
          <span className="text-zinc-300 dark:text-zinc-600">/</span>
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Settings
          </h1>
        </div>

        <RepoSetup />
        <ApiKeyManagement />
      </main>
    </div>
  )
}
