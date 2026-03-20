import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { buildSlackInstallUrl, fetchSlackInstallations } from "@/client/lib/api";
import { Button } from "@/client/components/ui/button";
import { Badge } from "@/client/components/ui/badge";
import { Skeleton } from "@/client/components/ui/skeleton";

export const Route = createFileRoute("/integrations")({
  component: IntegrationsPage,
});

const providerCards = [
  {
    description: "Mentions, DMs, and thread replies routed into a bound Flamecast connection.",
    href: "/api/integrations/slack/install",
    id: "slack",
    name: "Slack",
    state: "Live",
    tags: ["Workspace install", "Mentions", "DMs"],
  },
  {
    description: "Issue comments and agent sessions bound to existing connections.",
    href: null,
    id: "linear",
    name: "Linear",
    state: "Soon",
    tags: ["Issue comments", "Agent sessions", "Planned"],
  },
] as const;

function IntegrationsPage() {
  const { data: installations = [], isLoading } = useQuery({
    queryKey: ["integrations", "slack", "installations"],
    queryFn: fetchSlackInstallations,
    refetchInterval: 3000,
  });

  const installHref = buildSlackInstallUrl("/integrations");

  return (
    <div className="flex flex-col gap-10">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground/80">
          Integrations
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Install providers once.</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Then bind an installed workspace from any live connection.
        </p>
      </header>

      <section className="border-t">
        {providerCards.map((provider) => {
          const isSlack = provider.id === "slack";
          const installCount = isSlack ? installations.length : 0;

          return (
            <div
              key={provider.id}
              className={
                isSlack
                  ? "border-b py-6"
                  : "border-b border-dashed py-6"
              }
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <h2 className="text-xl font-medium">{provider.name}</h2>
                    <Badge variant={isSlack ? "default" : "secondary"}>{provider.state}</Badge>
                  </div>
                  <div className="space-y-1">
                    <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                      {provider.description}
                    </p>
                    <p className="text-sm">
                      {isSlack
                        ? `${installCount} workspace${installCount === 1 ? "" : "s"} installed`
                        : "Not available yet"}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {provider.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="font-normal">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-4">
                <p className="text-xs leading-5 text-muted-foreground">
                  {isSlack
                    ? "Slack installs persist locally and can be rebound without re-running OAuth."
                    : "Visible here so the page reads like a provider surface, not a Slack-only setup screen."}
                </p>
                {isSlack ? (
                  <Button asChild>
                    <a href={installHref}>Install Slack</a>
                  </Button>
                ) : (
                  <Button type="button" variant="outline" disabled>
                    Coming soon
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium">Installed Slack workspaces</h2>
            <p className="text-sm text-muted-foreground">
              Global installs that can be bound from any live connection.
            </p>
          </div>
          <Badge variant="secondary">{installations.length}</Badge>
        </div>

        <div className="border-t">
          {isLoading ? (
            <div className="flex flex-col gap-3 py-4">
              {Array.from({ length: 2 }).map((_, index) => (
                <Skeleton key={index} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : installations.length === 0 ? (
            <div className="py-10 text-sm text-muted-foreground">
              No Slack workspaces installed yet.
            </div>
          ) : (
            installations.map((installation) => (
              <div
                key={installation.teamId}
                className="flex flex-col gap-1 border-b py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <p className="font-medium">{installation.teamName ?? installation.teamId}</p>
                  <p className="text-xs text-muted-foreground">
                    Team ID: <code>{installation.teamId}</code>
                    {installation.botUserId ? (
                      <>
                        {" · "}Bot user: <code>{installation.botUserId}</code>
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="text-xs text-muted-foreground">
                  Updated {new Date(installation.updatedAt).toLocaleString()}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          After installing, bind a workspace from the connection you want to use.
        </p>
        <Button variant="outline" asChild>
          <Link to="/">Open connections</Link>
        </Button>
      </div>
    </div>
  );
}
