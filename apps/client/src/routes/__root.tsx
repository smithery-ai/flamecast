import { createRootRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { SessionsSidebar } from "@/components/sessions-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const breadcrumbs = useRouterState({
    select: (state) => {
      const runtimeMatch = state.matches.find(
        (m) =>
          m.routeId === "/runtimes/$typeName/$instanceName" || m.routeId === "/runtimes/$typeName",
      );
      const instanceMatch = state.matches.find(
        (m) => m.routeId === "/runtimes/$typeName/$instanceName",
      );
      const isAgents = state.matches.some((m) => m.routeId === "/agents");
      const sessionMatch = state.matches.find((m) => m.routeId === "/sessions/$sessionId");
      return {
        runtimeTypeName: runtimeMatch?.params.typeName,
        runtimeInstanceName: instanceMatch?.params.instanceName,
        isAgents,
        isSessionView: !!sessionMatch,
      };
    },
  });

  return (
    <>
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
                Home
              </Link>
              <Breadcrumbs {...breadcrumbs} />
            </nav>
          </header>
          <main className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
    </>
  );
}

function BreadcrumbSeparator() {
  return <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />;
}

function Breadcrumbs({
  runtimeTypeName,
  runtimeInstanceName,
  isAgents,
  isSessionView,
}: {
  runtimeTypeName?: string;
  runtimeInstanceName?: string;
  isAgents: boolean;
  isSessionView: boolean;
}) {
  if (isAgents) {
    return (
      <>
        <BreadcrumbSeparator />
        <span className="font-medium">Agents</span>
      </>
    );
  }

  if (isSessionView) {
    return (
      <>
        <BreadcrumbSeparator />
        <span className="font-medium">Previous Session</span>
      </>
    );
  }

  if (runtimeTypeName) {
    return (
      <>
        <BreadcrumbSeparator />
        <Link
          to="/runtimes/$typeName"
          params={{ typeName: runtimeTypeName }}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground [&.active]:font-medium [&.active]:text-foreground"
        >
          {runtimeTypeName}
        </Link>
        {runtimeInstanceName && runtimeInstanceName !== runtimeTypeName ? (
          <>
            <BreadcrumbSeparator />
            <span className="min-w-0 truncate font-medium">{runtimeInstanceName}</span>
          </>
        ) : null}
      </>
    );
  }

  return null;
}
