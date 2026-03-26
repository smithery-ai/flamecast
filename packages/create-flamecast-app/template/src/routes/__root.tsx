import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex h-14 items-center gap-4 border-b px-6">
        <Link to="/" className="font-semibold">
          Flamecast
        </Link>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}
