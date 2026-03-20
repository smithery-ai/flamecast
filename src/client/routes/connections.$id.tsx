import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bindSlackConnection,
  fetchConnection,
  fetchSlackInstallations,
  fetchSlackConnectionStatus,
  respondToPermission,
  sendPrompt,
  unbindSlackConnection,
} from "@/client/lib/api";
import { connectionLogsToSegments } from "@/client/lib/logs-markdown";
import { useEffect, useMemo, useState } from "react";
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
import { ScrollArea } from "@/client/components/ui/scroll-area";
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
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [slackError, setSlackError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: conn, isLoading } = useQuery({
    queryKey: ["connection", id],
    queryFn: () => fetchConnection(id),
    refetchInterval: 1000,
  });
  const { data: slackStatus } = useQuery({
    queryKey: ["connection", id, "slack"],
    queryFn: () => fetchSlackConnectionStatus(id),
    enabled: Boolean(conn),
    refetchInterval: 3000,
  });
  const { data: slackInstallations = [] } = useQuery({
    queryKey: ["integrations", "slack", "installations"],
    queryFn: fetchSlackInstallations,
    refetchInterval: 3000,
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

  const bindSlackMutation = useMutation({
    mutationFn: (teamId: string) => bindSlackConnection(id, teamId),
    onSuccess: () => {
      setSlackError(null);
      queryClient.invalidateQueries({ queryKey: ["connection", id, "slack"] });
      queryClient.invalidateQueries({ queryKey: ["integrations", "slack", "installations"] });
    },
    onError: (error) => {
      setSlackError(error instanceof Error ? error.message : "Failed to bind Slack workspace");
    },
  });

  const unbindSlackMutation = useMutation({
    mutationFn: () => unbindSlackConnection(id),
    onSuccess: () => {
      setSlackError(null);
      queryClient.invalidateQueries({ queryKey: ["connection", id, "slack"] });
      queryClient.invalidateQueries({ queryKey: ["integrations", "slack", "installations"] });
    },
    onError: (error) => {
      setSlackError(error instanceof Error ? error.message : "Failed to unbind Slack workspace");
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

  useEffect(() => {
    if (slackStatus?.teamId) {
      setSelectedTeamId(slackStatus.teamId);
      return;
    }

    if (!selectedTeamId && slackInstallations.length > 0) {
      setSelectedTeamId(slackInstallations[0].teamId);
    }
  }, [selectedTeamId, slackInstallations, slackStatus?.teamId]);

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
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Connection #{conn.id}</h1>
          <p className="text-sm text-muted-foreground">
            <Badge variant="secondary" className="mr-2">
              {conn.agentLabel}
            </Badge>
            Session: <code className="text-xs">{conn.sessionId}</code>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            <code className="rounded bg-muted px-1 py-0.5">
              {conn.spawn.command} {(conn.spawn.args ?? []).join(" ")}
            </code>
          </p>
        </div>
      </div>

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

      {/* Slack */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Slack</CardTitle>
          <CardDescription>
            Bind one globally installed Slack workspace to this live connection. Global installs
            live in Integrations, while connection bindings remain per-session.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="space-y-1 text-sm text-muted-foreground">
            {slackStatus?.bound ? (
              <>
                <p>
                  Bound workspace:{" "}
                  <span className="font-medium text-foreground">
                    {slackStatus.teamName ?? slackStatus.teamId}
                  </span>
                </p>
                <p className="text-xs">
                  Team ID: <code>{slackStatus.teamId}</code>
                  {slackStatus.botUserId ? (
                    <>
                      {" · "}Bot user: <code>{slackStatus.botUserId}</code>
                    </>
                  ) : null}
                </p>
              </>
            ) : (
              <p>No Slack workspace is bound to this connection yet.</p>
            )}
            <p className="text-xs">
              Installed globally: <span className="font-medium">{slackInstallations.length}</span>
            </p>
            {slackInstallations.length === 0 ? (
              <p className="text-xs">
                No installed workspaces yet. Open Integrations to complete Slack setup first.
              </p>
            ) : null}
            {slackError ? (
              <p className="text-xs text-destructive">{slackError}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <label htmlFor="slack-team" className="text-xs font-medium text-muted-foreground">
                Installed workspace
              </label>
              <select
                id="slack-team"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={selectedTeamId}
                onChange={(e) => setSelectedTeamId(e.target.value)}
                disabled={slackInstallations.length === 0 || bindSlackMutation.isPending}
              >
                {slackInstallations.length === 0 ? (
                  <option value="">No installed workspaces yet</option>
                ) : (
                  slackInstallations.map((installation) => (
                    <option key={installation.teamId} value={installation.teamId}>
                      {installation.teamName ?? installation.teamId}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => selectedTeamId && bindSlackMutation.mutate(selectedTeamId)}
                disabled={!selectedTeamId || bindSlackMutation.isPending}
              >
                {slackStatus?.bound ? "Rebind Workspace" : "Bind Workspace"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => unbindSlackMutation.mutate()}
                disabled={!slackStatus?.bound || unbindSlackMutation.isPending}
              >
                Unbind
              </Button>
              <Button variant="outline" asChild>
                <Link to="/integrations">Manage installs</Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

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
            <Button onClick={handleSend} disabled={promptMutation.isPending || !prompt.trim()}>
              <SendIcon data-icon="inline-start" />
              {promptMutation.isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Logs */}
      <Card>
        <CardHeader className="flex flex-col gap-4 space-y-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle>Logs</CardTitle>
            <CardDescription>{conn.logs.length} entries</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="markdown" className="w-full gap-4">
            <TabsList>
              <TabsTrigger value="markdown">Markdown</TabsTrigger>
              <TabsTrigger value="log">Log view</TabsTrigger>
            </TabsList>
            <TabsContent value="log" className="mt-4">
              <ScrollArea className="h-[500px]">
                <div className="flex flex-col gap-3 pr-4">
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
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="markdown" className="mt-4">
              <StickToBottom className="relative h-[500px]" resize="smooth" initial="smooth">
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
                </StickToBottom.Content>
                <MarkdownStickToBottomFab />
              </StickToBottom>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

function MarkdownStickToBottomFab() {
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
