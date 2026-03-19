import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { Separator } from "@/client/components/ui/separator";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
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
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
