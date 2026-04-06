import { createFileRoute, Link } from "@tanstack/react-router";
import { useSessions, useRuntimes, useTerminateSession } from "@flamecast/ui";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageSquareIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/sessions/")({
  component: SessionsIndexPage,
});

function SessionsIndexPage() {
  const { data: sessions, isLoading } = useSessions();
  const { data: runtimes } = useRuntimes();

  const terminateMutation = useTerminateSession({
    onError: (err) =>
      toast.error("Failed to terminate session", { description: String(err.message) }),
  });

  const resolveRuntimeLabel = (runtime: string | undefined) => {
    if (!runtime) return undefined;
    const rt = runtimes?.find(
      (r) => r.typeName === runtime || r.instances.some((i) => i.name === runtime),
    );
    const typeName = rt?.typeName;
    if (!typeName) return runtime;
    if (typeName === runtime) return typeName;
    return `${typeName}/${runtime}`;
  };

  return (
    <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto px-1">
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Sessions</h1>
          <p className="mt-1 text-sm text-muted-foreground">Active agent sessions.</p>
        </div>

        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg border bg-muted" />
            ))}
          </div>
        ) : !sessions?.length ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-8 text-center">
              <MessageSquareIcon className="mb-3 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm font-medium">No active sessions</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Create a session from the{" "}
                <Link to="/agents" className="underline underline-offset-2 hover:text-foreground">
                  agents
                </Link>{" "}
                page.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {sessions.map((session) => {
              const runtimeLabel = resolveRuntimeLabel(session.runtime);
              return (
                <div
                  key={session.id}
                  className="group flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors hover:bg-muted/50"
                >
                  <Link
                    to="/sessions/$id"
                    params={{ id: session.id }}
                    className="flex min-w-0 flex-1 items-center gap-3"
                  >
                    <span className="flex flex-col min-w-0 gap-0.5">
                      <span className="truncate font-medium">{session.agentName}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        ...{session.id.slice(-8)}
                        {runtimeLabel && (
                          <span
                            className={cn(
                              "ml-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium",
                              "bg-muted text-muted-foreground",
                            )}
                          >
                            {runtimeLabel}
                          </span>
                        )}
                      </span>
                    </span>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive hover:bg-destructive/10"
                    disabled={terminateMutation.isPending}
                    onClick={() => terminateMutation.mutate(session.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
