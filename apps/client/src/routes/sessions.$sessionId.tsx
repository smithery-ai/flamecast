import { createFileRoute } from "@tanstack/react-router";
import { useSession, sessionLogsToSegments } from "@flamecast/ui";
import { Fragment, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Streamdown } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon } from "lucide-react";

export const Route = createFileRoute("/sessions/$sessionId")({
  component: PreviousSessionPage,
});

function PreviousSessionPage() {
  const { sessionId } = Route.useParams();
  const { data: session, isLoading } = useSession(sessionId);

  const logs = useMemo(() => session?.logs ?? [], [session?.logs]);
  const markdownSegments = useMemo(() => sessionLogsToSegments(logs), [logs]);

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">Session not found.</p>
      </div>
    );
  }

  const title = session.title || "(empty session)";
  const endedAt = session.lastUpdatedAt
    ? new Date(session.lastUpdatedAt).toLocaleString()
    : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="text-xs text-muted-foreground">
            {endedAt ? `Ended ${endedAt}` : "Previous session"}
          </span>
        </div>
        <Badge variant="secondary" className="shrink-0">
          Ended
        </Badge>
      </div>

      {/* Conversation (read-only) */}
      <ReadOnlyConversation logs={logs} markdownSegments={markdownSegments} />
    </div>
  );
}

function ReadOnlyConversation({
  logs,
  markdownSegments,
}: {
  logs: { type: string; data: Record<string, unknown>; timestamp: string }[];
  markdownSegments: ReturnType<typeof sessionLogsToSegments>;
}) {
  return (
    <Tabs defaultValue="markdown" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center border-b px-3 py-2">
        <TabsList className="h-7">
          <TabsTrigger value="markdown" className="text-xs px-2 py-0.5">
            Markdown
          </TabsTrigger>
          <TabsTrigger value="traces" className="text-xs px-2 py-0.5">
            Traces
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="markdown" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <StickToBottom
            className="relative flex min-h-0 flex-1 flex-col"
            resize="smooth"
            initial="smooth"
          >
            <StickToBottom.Content className="flex flex-col gap-4 p-4">
              {markdownSegments.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No conversation recorded for this session.
                </p>
              ) : (
                markdownSegments.map((seg, index) => {
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
                      <Streamdown key={index} className="max-w-none">
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
            </StickToBottom.Content>
            <ScrollToBottomFab />
          </StickToBottom>
        </section>
      </TabsContent>

      <TabsContent value="traces" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <StickToBottom
            className="relative flex min-h-0 flex-1 flex-col"
            resize="smooth"
            initial="smooth"
          >
            <StickToBottom.Content className="flex flex-col gap-3 p-4">
              {logs.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No logs recorded for this session.
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
            <ScrollToBottomFab />
          </StickToBottom>
        </section>
      </TabsContent>
    </Tabs>
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

function ScrollToBottomFab() {
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
