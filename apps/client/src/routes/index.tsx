import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  const helloQuery = useQuery({
    queryKey: ["hello-world"],
    queryFn: async () => "Hello world",
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <Button>{helloQuery.data ?? "Loading..."}</Button>
    </main>
  );
}
