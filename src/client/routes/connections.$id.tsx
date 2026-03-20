import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchConnection, respondToPermission, sendPrompt } from "@/client/lib/api";
import { connectionLogsToSegments } from "@/client/lib/logs-markdown";
import { useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
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
import { Separator } from "@/client/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/client/components/ui/tabs";
import { Skeleton } from "@/client/components/ui/skeleton";
import { ArrowLeftIcon, ChevronDownIcon, SendIcon } from "lucide-react";

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

  const markdownSegments = useMemo(() => connectionLogsToSegments(conn?.logs ?? []), [conn?.logs]);

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
    <div className="flex h-full min-h-0 flex-col justify-between gap-6">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <Tabs defaultValue="markdown" className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <TabsList>
                <TabsTrigger value="markdown">Markdown</TabsTrigger>
                <TabsTrigger value="log">Log view</TabsTrigger>
              </TabsList>
              <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:gap-3">
                <Badge variant="secondary" className="shrink-0">
                  {conn.agentLabel}
                </Badge>
                <code
                  className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  title={conn.sessionId}
                >
                  {conn.sessionId}
                </code>
              </div>
            </div>
            <TabsContent value="log" className="mt-4 flex min-h-0 flex-1 flex-col">
              <StickToBottom
                className="relative flex min-h-0 flex-1 flex-col"
                resize="smooth"
                initial="smooth"
              >
                <StickToBottom.Content className="flex flex-col gap-3 pr-4">
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
                          <Badge variant={getLogVariant(log.type)} className="shrink-0">
                            {log.type}
                          </Badge>
                          <pre className="min-w-0 flex-1 overflow-auto rounded-md bg-muted p-2 text-xs">
                            {JSON.stringify(log.data, null, 2)}
                          </pre>
                        </div>
                        {i < conn.logs.length - 1 && <Separator className="mt-3" />}
                      </div>
                    ))
                  )}
                </StickToBottom.Content>
                <StickToBottomFab />
              </StickToBottom>
            </TabsContent>
            <TabsContent value="markdown" className="mt-4 flex min-h-0 flex-1 flex-col">
              <StickToBottom
                className="relative flex min-h-0 flex-1 flex-col"
                resize="smooth"
                initial="smooth"
              >
                <StickToBottom.Content className="flex flex-col gap-4 pr-4">
                  {markdownSegments.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      No conversation yet. Send a prompt or wait for session updates to show here.
                    </p>
                  ) : (
                    markdownSegments.map((seg, i) => {
                      const isLiveAssistant =
                        seg.kind === "assistant" &&
                        promptMutation.isPending &&
                        i === markdownSegments.length - 1;
                      if (seg.kind === "user") {
                        return (
                          <div
                            key={i}
                            className="rounded-lg border border-border/70 bg-muted/70 px-3 py-2.5 dark:bg-muted/40"
                          >
                            <Streamdown className="max-w-none text-foreground">
                              {seg.text}
                            </Streamdown>
                          </div>
                        );
                      }
                      if (seg.kind === "assistant") {
                        return (
                          <Streamdown
                            key={i}
                            className="max-w-none"
                            animated
                            isAnimating={isLiveAssistant}
                          >
                            {seg.text}
                          </Streamdown>
                        );
                      }
                      const toolMd = `**Tool:** ${seg.title}${seg.status ? ` — \`${seg.status}\`` : ""}`;
                      return (
                        <Streamdown key={i} className="max-w-none text-muted-foreground">
                          {`\n\n---\n\n${toolMd}\n\n`}
                        </Streamdown>
                      );
                    })
                  )}
                  {/* Pending permission approval */}

                  {conn.pendingPermission &&
                    (() => {
                      const pending = conn.pendingPermission;
                      return (
                        <Card className="border-amber-500/50 bg-amber-500/5">
                          <CardHeader>
                            <CardTitle className="text-base">Permission required</CardTitle>
                            <CardDescription>
                              {pending.title}
                              {pending.kind && (
                                <Badge variant="outline" className="ml-2">
                                  {pending.kind}
                                </Badge>
                              )}
                            </CardDescription>
                          </CardHeader>
                          <CardContent className="flex flex-wrap gap-2">
                            {pending.options.map((opt) => (
                              <Button
                                key={opt.optionId}
                                variant={opt.kind === "allow_once" ? "default" : "secondary"}
                                size="sm"
                                disabled={permissionMutation.isPending}
                                onClick={() =>
                                  handlePermission(pending.requestId, {
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
                                handlePermission(pending.requestId, {
                                  outcome: "cancelled",
                                })
                              }
                            >
                              Cancel
                            </Button>
                          </CardContent>
                        </Card>
                      );
                    })()}
                </StickToBottom.Content>
                <StickToBottomFab />
              </StickToBottom>
            </TabsContent>
          </Tabs>
        </div>
      </div>
      {/* Prompt Input */}
      <div className="flex shrink-0 flex-col gap-2">
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Send a prompt to the agent..."
              disabled={promptMutation.isPending}
            />
            <Button onClick={handleSend} disabled={promptMutation.isPending || !prompt.trim()}>
              <SendIcon data-icon="inline-start" />
              {promptMutation.isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StickToBottomFab() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-md"
      onClick={() => void scrollToBottom()}
      aria-label="Scroll to latest"
    >
      <ChevronDownIcon />
    </Button>
  );
}

function getLogVariant(type: string): "default" | "secondary" | "destructive" | "outline" {
  switch (type) {
    case "rpc":
      return "secondary";
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
