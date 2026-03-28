import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchSession } from "@/lib/api";
import { FileSystemPanel } from "@/components/filesystem-panel";
import { TerminalPanel } from "@/components/terminal-panel";
import { sessionLogsToSegments } from "@/lib/logs-markdown";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Streamdown } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ArrowLeftIcon, ChevronDownIcon, SendIcon, TerminalSquareIcon } from "lucide-react";
import type { FileSystemEntry, SessionLog } from "@flamecast/sdk/session";
import { PendingPermissionSchema } from "@flamecast/sdk/session";
import type { PermissionRequestEvent } from "@flamecast/protocol/session-host";
import { useFlamecastSession } from "@/hooks/use-flamecast-session";
import { useTerminal } from "@/hooks/use-terminal";

export const Route = createFileRoute("/sessions/$id")({
  component: SessionDetailPage,
});

function SessionDetailPage() {
  const { id } = Route.useParams();
  const [prompt, setPrompt] = useState("");
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [isSending, setIsSending] = useState(false);

  // REST for initial session metadata and server-owned filesystem snapshot
  const { data: session, isLoading } = useQuery({
    queryKey: ["session", id, showAllFiles],
    queryFn: () => fetchSession(id, { includeFileSystem: true, showAllFiles }),
    staleTime: Infinity, // runtime WS handles live updates
  });

  // Direct runtime WS for session events/control, server API for filesystem reads
  const {
    events: wsEvents,
    isConnected,
    prompt: wsPrompt,
    respondToPermission: wsRespondToPermission,
    requestFilePreview,
    requestFsSnapshot,
  } = useFlamecastSession(id, session?.websocketUrl);

  // Runtime-level terminal sessions over WebSocket
  const {
    terminals,
    sendInput: termSendInput,
    resize: termResize,
    onData: termOnData,
    createTerminal,
    killTerminal,
  } = useTerminal(session?.websocketUrl);

  // Merge: use WS events if available, fall back to REST logs
  const logs: SessionLog[] = useMemo(() => {
    if (wsEvents.length > 0) return [...wsEvents];
    return session?.logs ?? [];
  }, [wsEvents, session?.logs]);

  // Derive all pending permissions from WS events
  const pendingPermissions = useMemo(() => {
    const resolvedIds = new Set<string>();
    for (const event of wsEvents) {
      if (
        event.type === "permission_approved" ||
        event.type === "permission_rejected" ||
        event.type === "permission_cancelled" ||
        event.type === "permission_responded"
      ) {
        const rid = event.data.requestId;
        if (typeof rid === "string") resolvedIds.add(rid);
      }
    }
    const pending: PermissionRequestEvent[] = [];
    for (const event of wsEvents) {
      if (event.type === "permission_request") {
        const parsed = PendingPermissionSchema.safeParse(event.data);
        if (parsed.success && !resolvedIds.has(parsed.data.requestId)) {
          pending.push(parsed.data);
        }
      }
    }
    if (pending.length === 0 && session?.pendingPermission) {
      return [session.pendingPermission];
    }
    return pending;
  }, [wsEvents, session?.pendingPermission]);

  // Fetch filesystem snapshot via HTTP, refetch when files change
  const [fileEntries, setFileEntries] = useState<FileSystemEntry[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.fileSystem) return;
    setFileEntries(session.fileSystem.entries);
    setWorkspaceRoot(session.fileSystem.root);
  }, [session?.fileSystem]);

  // Fetch snapshot on connect and when filesystem.changed events arrive
  const fsChangeCount = useMemo(
    () => wsEvents.filter((e) => e.type === "filesystem.changed").length,
    [wsEvents],
  );

  useEffect(() => {
    if (!session) return;
    requestFsSnapshot({ showAllFiles })
      .then((snapshot) => {
        setFileEntries(snapshot.entries);
        setWorkspaceRoot(snapshot.root);
      })
      .catch(() => {});
  }, [fsChangeCount, requestFsSnapshot, session, showAllFiles]);
  const markdownSegments = useMemo(() => sessionLogsToSegments(logs), [logs]);

  const handlePermission = (
    requestId: string,
    body: { optionId: string } | { outcome: "cancelled" },
  ) => {
    wsRespondToPermission(requestId, body);
  };

  const handleSend = () => {
    if (!prompt.trim()) return;
    setIsSending(true);
    wsPrompt(prompt);
    setPrompt("");
    // Reset sending state after a short delay (the WS is fire-and-forget)
    setTimeout(() => setIsSending(false), 500);
  };

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[32rem] w-full rounded-xl" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center py-16">
        <p className="text-muted-foreground">Session not found.</p>
        <Button variant="outline" asChild>
          <Link to="/">
            <ArrowLeftIcon data-icon="inline-start" />
            Back to sessions
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-3 pb-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:gap-3">
          <Badge variant="secondary" className="shrink-0">
            {session.agentName}
          </Badge>
          <code
            className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            title={session.id}
          >
            {session.id}
          </code>
          {isConnected ? (
            <Badge variant="outline" className="text-green-600">
              WS
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              SSE
            </Badge>
          )}
        </div>
      </div>

      <Tabs defaultValue="markdown" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <div className="flex shrink-0 items-center gap-3">
          <TabsList>
            <TabsTrigger value="markdown">Markdown</TabsTrigger>
            <TabsTrigger value="log">Traces</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="terminals">
              <TerminalSquareIcon className="size-3.5" />
              Terminals
              {terminals.length > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 text-[10px]">
                  {terminals.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="markdown" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
            <StickToBottom
              className="relative flex min-h-0 flex-1 flex-col"
              resize="smooth"
              initial="smooth"
            >
              <StickToBottom.Content className="flex flex-col gap-4 p-4">
                {markdownSegments.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No conversation yet. Send a prompt or wait for session updates to show here.
                  </p>
                ) : (
                  markdownSegments.map((seg, index) => {
                    const isLiveAssistant =
                      seg.kind === "assistant" &&
                      isSending &&
                      index === markdownSegments.length - 1;
                    if (seg.kind === "user") {
                      return (
                        <div
                          key={index}
                          className="rounded-lg border border-border/70 bg-muted/70 px-3 py-2.5 dark:bg-muted/40"
                        >
                          <Streamdown className="max-w-none text-foreground">{seg.text}</Streamdown>
                        </div>
                      );
                    }
                    if (seg.kind === "assistant") {
                      return (
                        <Streamdown
                          key={index}
                          className="max-w-none"
                          animated
                          isAnimating={isLiveAssistant}
                        >
                          {seg.text}
                        </Streamdown>
                      );
                    }
                    if (seg.kind === "tool") {
                      const toolMd = `**Tool:** ${seg.title}${seg.status ? ` — \`${seg.status}\`` : ""}`;
                      return (
                        <Fragment key={index}>
                          {index > 0 ? <Separator /> : null}
                          <Streamdown className="max-w-none text-muted-foreground">
                            {toolMd}
                          </Streamdown>
                        </Fragment>
                      );
                    }
                    return null;
                  })
                )}
                {pendingPermissions.map((pending) => (
                  <Card
                    key={pending.requestId}
                    className="max-w-2xl border-primary/50 bg-primary/5"
                  >
                    <CardHeader>
                      <CardTitle className="text-base">Permission required</CardTitle>
                      <CardDescription>
                        {pending.title}
                        {pending.kind ? (
                          <Badge variant="outline" className="ml-2">
                            {pending.kind}
                          </Badge>
                        ) : null}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2">
                      {pending.options.map((opt) => (
                        <Button
                          key={opt.optionId}
                          variant={opt.kind === "allow_once" ? "default" : "secondary"}
                          size="sm"
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
                ))}
              </StickToBottom.Content>
              <StickToBottomFab />
            </StickToBottom>
          </section>
        </TabsContent>

        <TabsContent value="log" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
            <StickToBottom
              className="relative flex min-h-0 flex-1 flex-col"
              resize="smooth"
              initial="smooth"
            >
              <StickToBottom.Content className="flex flex-col gap-3 p-4">
                {logs.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No logs yet. Send a prompt to get started.
                  </p>
                ) : (
                  logs.map((log, index) => (
                    <Fragment key={index}>
                      {index > 0 ? <Separator /> : null}
                      <div className="flex items-start gap-3 text-sm">
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                        <div className="min-w-0 flex-1 flex-col gap-2">
                          <Badge variant={getLogVariant(log.type)} className="w-fit shrink-0">
                            {log.type}
                          </Badge>
                          <pre className="min-w-0 overflow-auto rounded-md bg-muted p-2 text-xs">
                            {JSON.stringify(log.data, null, 2)}
                          </pre>
                        </div>
                      </div>
                    </Fragment>
                  ))
                )}
              </StickToBottom.Content>
              <StickToBottomFab />
            </StickToBottom>
          </section>
        </TabsContent>

        <TabsContent value="files" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <FileSystemPanel
            workspaceRoot={workspaceRoot}
            entries={fileEntries}
            showAllFiles={showAllFiles}
            onShowAllFilesChange={setShowAllFiles}
            loadPreview={requestFilePreview}
          />
        </TabsContent>

        <TabsContent value="terminals" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <TerminalPanel
            terminals={terminals}
            sendInput={termSendInput}
            resize={termResize}
            onData={termOnData}
            onCreateTerminal={() => createTerminal()}
            onRemoveTerminal={killTerminal}
          />
        </TabsContent>
      </Tabs>

      <div className="flex shrink-0 flex-col gap-2 pt-4">
        <div className="flex gap-2 p-1">
          <Input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && handleSend()}
            placeholder="Send a prompt to the agent..."
            disabled={isSending || pendingPermissions.length > 0}
          />
          <Button
            onClick={handleSend}
            disabled={isSending || pendingPermissions.length > 0 || !prompt.trim()}
          >
            <SendIcon data-icon="inline-start" />
            {pendingPermissions.length > 0
              ? "Permission required"
              : isSending
                ? "Sending…"
                : "Send"}
          </Button>
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
