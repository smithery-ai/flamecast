import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchSessions } from "@/lib/api";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
  });

  if (isLoading) {
    return <p className="text-muted-foreground">Loading sessions...</p>;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Sessions</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {sessions.length} active session{sessions.length !== 1 ? "s" : ""}
      </p>
      <ul className="mt-4 space-y-2">
        {sessions.map((session) => (
          <li key={session.id} className="rounded-lg border p-4">
            <p className="font-medium">{session.agentName}</p>
            <code className="text-xs text-muted-foreground">{session.id}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
