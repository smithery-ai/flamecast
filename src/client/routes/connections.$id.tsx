import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchConnection,
  respondToPermission,
  sendPrompt,
} from "@/client/lib/api";
import { useState } from "react";
import { Button } from "@/client/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";
import { Badge } from "@/client/components/ui/badge";
import { Input } from "@/client/components/ui/input";
import { ScrollArea } from "@/client/components/ui/scroll-area";
import { Separator } from "@/client/components/ui/separator";
import { Skeleton } from "@/client/components/ui/skeleton";
import { ArrowLeftIcon, SendIcon } from "lucide-react";

export const Route = createFileRoute("/connections/$id")({
  component: ConnectionDetailPage,
});

function ConnectionDetailPage() {
  const { id } = Route.useParams();
  const [prompt, setPrompt] = useState("");
  const queryClient = useQueryClient();

  const { data: conn, isLoading } = useQuery({
    queryKey: ["connection", id],
    queryFn: () => fetchConnection(id),
    refetchInterval: 1000,
  });

  const promptMutation = useMutation({
    mutationFn: (text: string) => sendPrompt(id, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connection", id] });
    },
  });

  const permissionMutation = useMutation({
    mutationFn: ({
      requestId,
      body,
    }: {
      requestId: string;
      body: { optionId: string } | { outcome: "cancelled" };
    }) => respondToPermission(id, requestId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connection", id] });
    },
  });

  const handlePermission = (
    requestId: string,
    body: { optionId: string } | { outcome: "cancelled" },
  ) => {
    permissionMutation.mutate({ requestId, body });
  };

  const handleSend = () => {
    if (!prompt.trim()) return;
    promptMutation.mutate(prompt);
    setPrompt("");
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!conn) {
    return (
      <div className="flex flex-col items-center gap-4 py-16">
        <p className="text-muted-foreground">Connection not found.</p>
        <Button variant="outline" asChild>
          <Link to="/">
            <ArrowLeftIcon data-icon="inline-start" />
            Back to connections
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Connection #{conn.id}
          </h1>
          <p className="text-sm text-muted-foreground">
            <Badge variant="secondary" className="mr-2">
              {conn.agentType}
            </Badge>
            Session: <code className="text-xs">{conn.sessionId}</code>
          </p>
        </div>
      </div>

      {/* Pending permission approval */}
      {conn.pendingPermission && (
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-base">
              Permission required
            </CardTitle>
            <CardDescription>
              {conn.pendingPermission.title}
              {conn.pendingPermission.kind && (
                <Badge variant="outline" className="ml-2">
                  {conn.pendingPermission.kind}
                </Badge>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {conn.pendingPermission.options.map((opt) => (
              <Button
                key={opt.optionId}
                variant={opt.kind === "allow_once" ? "default" : "secondary"}
                size="sm"
                disabled={permissionMutation.isPending}
                onClick={() =>
                  handlePermission(conn.pendingPermission!.requestId, {
                    optionId: opt.optionId,
                  })
                }
              >
                {opt.name}
              </Button>
            ))}
            <Button
              variant="outline"
              size="sm"
              disabled={permissionMutation.isPending}
              onClick={() =>
                handlePermission(conn.pendingPermission!.requestId, {
                  outcome: "cancelled",
                })
              }
            >
              Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Prompt Input */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-2">
            <Input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Send a prompt to the agent..."
              disabled={promptMutation.isPending}
            />
            <Button
              onClick={handleSend}
              disabled={promptMutation.isPending || !prompt.trim()}
            >
              <SendIcon data-icon="inline-start" />
              {promptMutation.isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Logs */}
      <Card>
        <CardHeader>
          <CardTitle>Logs</CardTitle>
          <CardDescription>{conn.logs.length} entries</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[500px]">
            <div className="flex flex-col gap-3">
              {conn.logs.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No logs yet. Send a prompt to get started.
                </p>
              ) : (
                conn.logs.map((log, i) => (
                  <div key={i}>
                    <div className="flex items-start gap-3 text-sm">
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <Badge
                        variant={getLogVariant(log.type)}
                        className="shrink-0"
                      >
                        {log.type}
                      </Badge>
                      <pre className="min-w-0 flex-1 overflow-auto rounded-md bg-muted p-2 text-xs">
                        {JSON.stringify(log.data, null, 2)}
                      </pre>
                    </div>
                    {i < conn.logs.length - 1 && (
                      <Separator className="mt-3" />
                    )}
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

function getLogVariant(
  type: string,
): "default" | "secondary" | "destructive" | "outline" {
  switch (type) {
    case "initialized":
    case "session_created":
      return "default";
    case "prompt_sent":
    case "prompt_completed":
      return "secondary";
    case "permission_approved":
      return "default";
    case "permission_rejected":
    case "permission_cancelled":
    case "permission_requested":
    case "killed":
      return "destructive";
    case "permission_responded":
      return "outline";
    default:
      return "outline";
  }
}
