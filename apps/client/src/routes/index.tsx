import { createFileRoute, Link } from "@tanstack/react-router";
import { useRuntimes, useSessions, useAgentTemplates } from "@flamecast/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TerminalIcon, BoxIcon, MessageSquareIcon } from "lucide-react";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { data: runtimes } = useRuntimes();
  const { data: sessions } = useSessions();
  const { data: templates } = useAgentTemplates();

  const runtimeCount = runtimes?.reduce((n, rt) => n + rt.instances.length, 0) ?? 0;
  const sessionCount = sessions?.length ?? 0;
  const templateCount = templates?.length ?? 0;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col items-center justify-center gap-10 px-1">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">Flamecast</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Manage your agents, runtimes, and sessions.
        </p>
      </div>

      <div className="grid w-full gap-4 sm:grid-cols-3">
        <Link to="/templates">
          <Card className="transition-colors hover:border-foreground/20 cursor-pointer h-full">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <TerminalIcon className="h-4 w-4" />
                </div>
                <CardTitle className="text-sm font-semibold">Templates</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {templateCount > 0
                  ? `${templateCount} registered template${templateCount !== 1 ? "s" : ""}`
                  : "Register agent templates"}
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link to="/sessions">
          <Card className="transition-colors hover:border-foreground/20 cursor-pointer h-full">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <MessageSquareIcon className="h-4 w-4" />
                </div>
                <CardTitle className="text-sm font-semibold">Sessions</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {sessionCount > 0
                  ? `${sessionCount} active session${sessionCount !== 1 ? "s" : ""}`
                  : "No active sessions"}
              </p>
            </CardContent>
          </Card>
        </Link>

        {runtimes && runtimes.length > 0 && (
          <Card className="h-full">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <BoxIcon className="h-4 w-4" />
                </div>
                <CardTitle className="text-sm font-semibold">Runtimes</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                {runtimeCount} instance{runtimeCount !== 1 ? "s" : ""} across {runtimes.length}{" "}
                runtime{runtimes.length !== 1 ? "s" : ""}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {runtimes.map((rt) => (
                  <Link
                    key={rt.typeName}
                    to="/runtimes/$typeName"
                    params={{ typeName: rt.typeName }}
                    className="inline-block rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:bg-muted"
                  >
                    {rt.typeName}
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
