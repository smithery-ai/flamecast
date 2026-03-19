import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchConnections, createConnection, killConnection } from "@/client/lib/api";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card";
import { Badge } from "@/client/components/ui/badge";
import { Skeleton } from "@/client/components/ui/skeleton";
import { Trash2Icon, PlusIcon, ZapIcon } from "lucide-react";

export const Route = createFileRoute("/")({
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: connections, isLoading } = useQuery({
    queryKey: ["connections"],
    queryFn: fetchConnections,
    refetchInterval: 3000,
  });

  const createMutation = useMutation({
    mutationFn: (agent: string) => createConnection(agent),
    onSuccess: (conn) => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      navigate({ to: "/connections/$id", params: { id: conn.id } });
    },
  });

  const killMutation = useMutation({
    mutationFn: (id: string) => killConnection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Connections</h1>
          <p className="text-sm text-muted-foreground">
            Manage your agent connections
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => createMutation.mutate("example")}
            disabled={createMutation.isPending}
          >
            <PlusIcon data-icon="inline-start" />
            Example Agent
          </Button>
          <Button
            variant="secondary"
            onClick={() => createMutation.mutate("codex")}
            disabled={createMutation.isPending}
          >
            <ZapIcon data-icon="inline-start" />
            Codex Agent
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : connections?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-muted-foreground">
              No active connections. Create one to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {connections?.map((conn) => (
            <Card
              key={conn.id}
              className="cursor-pointer transition-colors hover:bg-muted/50"
              onClick={() =>
                navigate({
                  to: "/connections/$id",
                  params: { id: conn.id },
                })
              }
            >
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-base">
                    Connection #{conn.id}
                  </CardTitle>
                  <Badge variant="secondary">{conn.agentType}</Badge>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    killMutation.mutate(conn.id);
                  }}
                >
                  <Trash2Icon className="text-destructive" />
                </Button>
              </CardHeader>
              <CardContent>
                <div className="flex gap-6 text-sm text-muted-foreground">
                  <span>
                    Session:{" "}
                    <code className="text-xs">{conn.sessionId.slice(0, 12)}…</code>
                  </span>
                  <span>{conn.logs.length} log entries</span>
                  <span>
                    Started{" "}
                    {new Date(conn.startedAt).toLocaleTimeString()}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
