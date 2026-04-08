import { createFileRoute } from "@tanstack/react-router";
import { useAgentTemplates, useAcpSession, useCollections } from "@flamecast/ui";
import { SessionChat } from "@/components/session-chat";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { data: templates, isLoading: templatesLoading } = useAgentTemplates();
  const acpSession = useAcpSession();
  const collections = useCollections();

  // Use the conductor's connection ID as the session filter
  const connections = [...collections.connections.toArray];
  const activeConnection = connections[0];
  const sessionId = activeConnection?.logicalConnectionId ?? "";

  // If ACP session is connected and we have a connection, show the chat
  if (acpSession.isReady && sessionId) {
    return <SessionChat sessionId={sessionId} />;
  }

  // Otherwise show the landing page
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
            <p className="text-sm text-muted-foreground">No agents configured.</p>
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

        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {acpSession.error ? (
            <p className="text-red-500">Connection error: {acpSession.error.message}</p>
          ) : (
            <p>Connecting to conductor via ACP...</p>
          )}
        </div>
      </div>
    </div>
  );
}
