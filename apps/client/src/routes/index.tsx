import { createFileRoute } from "@tanstack/react-router";
import { useAgentTemplates, useSessions } from "@flamecast/ui";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { data: templates, isLoading: templatesLoading } = useAgentTemplates();
  const { data: sessions } = useSessions();

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8 px-4">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">Flamecast</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Powered by durable-acp-rs
        </p>
      </div>

      <div className="w-full space-y-6">
        <div>
          <h2 className="text-lg font-semibold">Agent Templates</h2>
          {templatesLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents configured. Add agents to agents.toml.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {templates.map((t) => (
                <li key={t.name} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{t.name}</span>
                  {t.agent && <span className="text-xs text-muted-foreground">{t.agent}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h2 className="text-lg font-semibold">Active Sessions</h2>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active sessions. Start a conductor to see sessions here.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {sessions.map((s) => (
                <li key={s.logicalConnectionId} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="font-mono text-xs">{s.logicalConnectionId.slice(0, 12)}...</span>
                  <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                    {s.state}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
