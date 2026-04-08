import { createFileRoute } from "@tanstack/react-router";
import { useAgentTemplates } from "@flamecast/ui";

export const Route = createFileRoute("/agents")({
  component: AgentsPage,
});

function AgentsPage() {
  const { data: templates, isLoading, error } = useAgentTemplates();

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-bold">Agents</h1>
      <p className="text-sm text-muted-foreground">
        Configured in agents.toml. Served by the conductor at /api/v1/agent-templates.
      </p>

      {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {error && <p className="text-sm text-red-500">{error.message}</p>}

      {templates.length === 0 && !isLoading ? (
        <p className="text-sm text-muted-foreground">No agents configured.</p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <div key={t.name} className="rounded-lg border p-4">
              <div className="font-medium">{t.name}</div>
              {t.agent && (
                <div className="mt-1 text-xs text-muted-foreground">
                  Agent: {t.agent}
                </div>
              )}
              {t.command && (
                <div className="mt-1 font-mono text-xs text-muted-foreground">
                  {t.command.join(" ")}
                </div>
              )}
              <div className="mt-1 text-xs text-muted-foreground">
                Port: {t.port}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
