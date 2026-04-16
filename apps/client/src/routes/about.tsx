import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, Workflow } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export const Route = createFileRoute('/about')({
  component: AboutPage,
})

function AboutPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center px-4 py-12 sm:px-6">
      <Card className="w-full">
        <CardHeader className="space-y-4">
          <Badge variant="outline" className="w-fit">
            client refactor
          </Badge>
          <CardTitle className="text-3xl">
            This app is now a typed Flamecast dashboard.
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm text-muted-foreground">
          <p>
            The starter marketing UI was replaced with shadcn-style components,
            TanStack Query request orchestration, and Hono RPC calls that come
            directly from `packages/flamecast`.
          </p>
          <p>
            The home page exercises the live session list, detail view, command
            execution, manual input, and close flows without any ad hoc `fetch`
            wrappers.
          </p>
          <div>
            <Button asChild>
              <Link to="/">
                <ArrowLeft className="size-4" />
                Back to the dashboard
              </Link>
            </Button>
          </div>
          <div className="flex items-center gap-2 text-foreground">
            <Workflow className="size-4" />
            <span>packages/flamecast / Hono RPC / TanStack Query / shadcn UI</span>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
