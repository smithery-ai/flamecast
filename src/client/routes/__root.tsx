import { createRootRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const connectionId = useRouterState({
    select: (state) => state.matches.find((m) => m.routeId === "/connections/$id")?.params.id,
  });

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 shrink-0 border-b bg-background">
        <div className="mx-auto flex items-center gap-2 px-6 py-4 sm:gap-3">
          <Link to="/" className="text-lg font-bold tracking-tight">
            🔥 Flamecast
          </Link>
          <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <nav className="flex items-center gap-2 text-sm sm:gap-3">
            <Link
              to="/"
              className="text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
            >
              Connections
            </Link>
            {connectionId ? (
              <>
                <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span
                  className="max-w-[min(24rem,calc(100vw-12rem))] truncate font-mono text-xs text-muted-foreground"
                  title={connectionId}
                >
                  {connectionId}
                </span>
              </>
            ) : null}
          </nav>
        </div>
      </header>
      <main className="mx-auto flex min-h-0 w-full flex-1 flex-col overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
