import { createRootRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { z } from "zod";
import { ChevronRightIcon } from "lucide-react";
import { SessionsSidebar } from "@/client/components/sessions-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/client/components/ui/sidebar";

const rootSearchSchema = z.object({
  runtime: z.string().optional(),
});

export const Route = createRootRoute({
  validateSearch: rootSearchSchema,
  component: RootLayout,
});

function RootLayout() {
  const sessionId = useRouterState({
    select: (state) => state.matches.find((m) => m.routeId === "/sessions/$id")?.params.id,
  });

  return (
    <SidebarProvider className="h-svh !min-h-0">
      <SessionsSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
          <SidebarTrigger />
          <nav className="flex min-w-0 flex-1 items-center gap-2 text-sm sm:gap-3">
            <Link
              to="/"
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
            >
              Sessions
            </Link>
            {sessionId ? (
              <>
                <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span
                  className="min-w-0 truncate font-mono text-xs text-muted-foreground"
                  title={sessionId}
                >
                  {sessionId}
                </span>
              </>
            ) : null}
          </nav>
        </header>
        <main className="flex min-h-0 flex-1 flex-col p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
