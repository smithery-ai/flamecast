import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useSessionState } from "@flamecast/ui";
import { FileSystemPanel } from "@/components/filesystem-panel";
import { RuntimeFileSystemProvider } from "@/contexts/runtime-filesystem-context";
import { Fragment, useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Streamdown } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ArrowLeftIcon, ChevronDownIcon, SendIcon } from "lucide-react";

export const Route = createFileRoute("/sessions/$id")({
  component: SessionDetailPage,
});

function SessionDetailPage() {
  const { id } = Route.useParams();
  // oxlint-disable-next-line no-type-assertion/no-type-assertion -- TanStack Router search params are untyped with strict:false
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const initialPrompt = typeof search.prompt === "string" ? search.prompt : undefined;
  const [promptText, setPromptText] = useState("");

  const {
    session,
    isLoading,
    isConnected,
    logs,
    markdownSegments,
    isProcessing,
    pendingPermissions,
    respondToPermission,
    fileEntries,
    workspaceRoot,
    showAllFiles,
    setShowAllFiles,
    prompt,
    requestFilePreview,
  } = useSessionState(id);

  // Auto-send initial prompt when navigating from the home page
  const sentInitialPrompt = useRef(false);
  useEffect(() => {
    if (initialPrompt && isConnected && !sentInitialPrompt.current) {
      sentInitialPrompt.current = true;
      prompt(initialPrompt);
    }
  }, [initialPrompt, isConnected, prompt]);

  const handleSend = useCallback(() => {
    if (!promptText.trim()) return;
    prompt(promptText);
    setPromptText("");
  }, [promptText, prompt]);

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
            Back
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col overflow-hidden">
      <Tabs defaultValue="markdown" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <div className="flex shrink-0 items-center gap-3">
          <TabsList>
            <TabsTrigger value="markdown">Markdown</TabsTrigger>
            <TabsTrigger value="log">Traces</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
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
                      isProcessing &&
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
                            respondToPermission(pending.requestId, { optionId: opt.optionId })
                          }
                        >
                          {opt.name}
                        </Button>
                      ))}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          respondToPermission(pending.requestId, { outcome: "cancelled" })
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
          <RuntimeFileSystemProvider
            showAllFiles={showAllFiles}
            setShowAllFiles={setShowAllFiles}
            loadPreview={requestFilePreview}
          >
            <FileSystemPanel workspaceRoot={workspaceRoot} entries={fileEntries} />
          </RuntimeFileSystemProvider>
        </TabsContent>
      </Tabs>

      <div className="flex shrink-0 flex-col gap-2 pt-4">
        <div className="flex gap-2 p-1">
          <Input
            value={promptText}
            onChange={(event) => setPromptText(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && handleSend()}
            placeholder="Send a prompt to the agent..."
            disabled={isProcessing || pendingPermissions.length > 0}
          />
          <Button
            onClick={handleSend}
            disabled={isProcessing || pendingPermissions.length > 0 || !promptText.trim()}
          >
            <SendIcon data-icon="inline-start" />
            {pendingPermissions.length > 0
              ? "Permission required"
              : isProcessing
                ? "Processing…"
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
