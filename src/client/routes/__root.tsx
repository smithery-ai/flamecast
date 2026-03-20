import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { Separator } from "@/client/components/ui/separator";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 shrink-0 border-b bg-background">
        <div className="mx-auto flex items-center gap-6 px-6 py-4">
          <Link to="/" className="text-lg font-bold tracking-tight">
            🔥 Flamecast
          </Link>
          <Separator orientation="vertical" className="h-5" />
          <nav className="flex gap-4 text-sm">
            <Link
              to="/"
              className="text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
            >
              Connections
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex min-h-0 w-full flex-1 flex-col overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
