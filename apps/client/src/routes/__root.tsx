import { createRootRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { ChevronRightIcon, CpuIcon, MemoryStickIcon } from "lucide-react";
import { SessionsSidebar } from "@/components/sessions-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { useRuntimes, useSystemVitals } from "@flamecast/ui";

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
      return {
        runtimeTypeName: runtimeMatch?.params.typeName,
        runtimeInstanceName: instanceMatch?.params.instanceName,
        isAgents,
      };
    },
  });

  // Resolve the websocket URL for the current runtime instance (if any)
  const { data: runtimes } = useRuntimes();
  const websocketUrl = runtimes
    ?.find((rt) => rt.typeName === breadcrumbs.runtimeTypeName)
    ?.instances.find((i) => i.name === (breadcrumbs.runtimeInstanceName ?? breadcrumbs.runtimeTypeName))
    ?.websocketUrl;

  const vitals = useSystemVitals(websocketUrl);

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
            {vitals && <SystemVitalsIndicator vitals={vitals} />}
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
}: {
  runtimeTypeName?: string;
  runtimeInstanceName?: string;
  isAgents: boolean;
}) {
  if (isAgents) {
    return (
      <>
        <BreadcrumbSeparator />
        <span className="font-medium">Agents</span>
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

// ─── System Vitals ────────────────────────────────────────────────────────────

function vitalsColor(percent: number): string {
  if (percent < 60) return "text-muted-foreground";
  if (percent < 80) return "text-amber-500";
  return "text-red-500";
}

function SystemVitalsIndicator({ vitals }: { vitals: { cpuPercent: number; memPercent: number; memUsedMB: number; memTotalMB: number } }) {
  return (
    <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground">
      <span className={`flex items-center gap-1 ${vitalsColor(vitals.cpuPercent)}`}>
        <CpuIcon className="size-3.5" />
        {vitals.cpuPercent.toFixed(0)}%
      </span>
      <span className={`flex items-center gap-1 ${vitalsColor(vitals.memPercent)}`}>
        <MemoryStickIcon className="size-3.5" />
        {formatMB(vitals.memUsedMB)}/{formatMB(vitals.memTotalMB)}
      </span>
    </div>
  );
}

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}
