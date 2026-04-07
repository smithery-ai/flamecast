import { useSessionState, useSessionFileSystem, useTerminal, useFlamecastClient } from "@flamecast/ui";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { RuntimeFileTree } from "@/components/runtime-file-tree";
import { RuntimeFileTab } from "@/components/runtime-file-tab";
import { TerminalPanel } from "@/components/terminal-panel";
import { Streamdown } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import {
  ChevronDownIcon,
  SendIcon,
  LoaderCircleIcon,
  GripHorizontalIcon,
} from "lucide-react";

export function RuntimeSessionTab({
  sessionId,
  runtimeWebsocketUrl,
  initialPrompt,
  onOpenFileTab,
}: {
  sessionId: string;
  runtimeWebsocketUrl?: string;
  initialPrompt?: string;
  onOpenFileTab?: (filePath: string) => void;
}) {
  const client = useFlamecastClient();
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
    prompt,
  } = useSessionState(sessionId);

  // Session-scoped filesystem state
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [fsPath, setFsPath] = useState<string | undefined>(undefined);

  const sessionFsQuery = useSessionFileSystem(sessionId, {
    enabled: !!session,
    showAllFiles,
    path: fsPath,
  });

  // Session-scoped terminal (connects to the runtime instance)
  const { terminals, sendInput, resize, onData, createTerminal, killTerminal } = useTerminal(
    runtimeWebsocketUrl,
  );

  // Inline file preview for files opened from session file tree
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);

  const loadPreview = useCallback(
    (path: string) => client.fetchSessionFilePreview(sessionId, path),
    [client, sessionId],
  );

  const handleFileSelect = useCallback(
    (filePath: string) => {
      if (onOpenFileTab) {
        onOpenFileTab(filePath);
      } else {
        setPreviewFilePath(filePath);
      }
    },
    [onOpenFileTab],
  );

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
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
        <p className="text-sm text-muted-foreground">Session not found.</p>
      </div>
    );
  }

  return (
    <ResizablePanelGroup className="min-h-0 flex-1">
      {/* Left: Conversation */}
      <ResizablePanel defaultSize={65} minSize={30}>
        <SessionConversation
          promptText={promptText}
          setPromptText={setPromptText}
          handleSend={handleSend}
          logs={logs}
          markdownSegments={markdownSegments}
          isProcessing={isProcessing}
          pendingPermissions={pendingPermissions}
          respondToPermission={respondToPermission}
          previewFilePath={previewFilePath}
          onClosePreview={() => setPreviewFilePath(null)}
          loadPreview={loadPreview}
        />
      </ResizablePanel>

      <ResizableHandle />

      {/* Right: Filesystem + Terminal (session-scoped) */}
      <ResizablePanel defaultSize={35} minSize={20}>
        <VerticalSplitPanel
          topContent={
            sessionFsQuery.isLoading ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
                <LoaderCircleIcon className="size-3.5 animate-spin" />
                Loading filesystem...
              </div>
            ) : sessionFsQuery.isError || !sessionFsQuery.data ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
                <p className="text-xs text-muted-foreground">Could not load filesystem</p>
                <Button variant="outline" size="sm" onClick={() => void sessionFsQuery.refetch()}>
                  Retry
                </Button>
              </div>
            ) : (
              <RuntimeFileTree
                workspaceRoot={sessionFsQuery.data.root}
                currentPath={sessionFsQuery.data.path ?? sessionFsQuery.data.root}
                entries={sessionFsQuery.data.entries}
                showAllFiles={showAllFiles}
                onShowAllFilesChange={setShowAllFiles}
                onFileSelect={handleFileSelect}
                onNavigate={setFsPath}
              />
            )
          }
          bottomContent={
            <TerminalPanel
              terminals={terminals}
              sendInput={sendInput}
              resize={resize}
              onData={onData}
              onCreateTerminal={() => createTerminal()}
              onRemoveTerminal={killTerminal}
            />
          }
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

// ─── Conversation Panel ───────────────────────────────────────────────────────

function SessionConversation({
  promptText,
  setPromptText,
  handleSend,
  logs,
  markdownSegments,
  isProcessing,
  pendingPermissions,
  respondToPermission,
  previewFilePath,
  onClosePreview,
  loadPreview,
}: {
  promptText: string;
  setPromptText: (v: string) => void;
  handleSend: () => void;
  logs: ReturnType<typeof useSessionState>["logs"];
  markdownSegments: ReturnType<typeof useSessionState>["markdownSegments"];
  isProcessing: boolean;
  pendingPermissions: ReturnType<typeof useSessionState>["pendingPermissions"];
  respondToPermission: ReturnType<typeof useSessionState>["respondToPermission"];
  previewFilePath: string | null;
  onClosePreview: () => void;
  loadPreview: (path: string) => Promise<{ content: string; truncated: boolean }>;
}) {
  if (previewFilePath) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center border-b px-3 py-1">
          <Button variant="ghost" size="sm" onClick={onClosePreview} className="text-xs">
            Back to conversation
          </Button>
          <span className="ml-2 truncate text-xs text-muted-foreground">{previewFilePath}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <RuntimeFileTab filePath={previewFilePath} loadPreview={loadPreview} />
        </div>
      </div>
    );
  }

  return (
    <Tabs defaultValue="markdown" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center border-b px-3 py-1">
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
                  No conversation yet. Send a prompt below.
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
                <Card key={pending.requestId} className="max-w-2xl border-primary/50 bg-primary/5">
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
            <ScrollToBottomFab />
          </StickToBottom>
        </section>
      </TabsContent>

      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2">
        <Input
          value={promptText}
          onChange={(event) => setPromptText(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && handleSend()}
          placeholder="Send a prompt to the agent..."
          disabled={isProcessing || pendingPermissions.length > 0}
          className="h-8 text-sm"
        />
        <Button
          size="sm"
          onClick={handleSend}
          disabled={isProcessing || pendingPermissions.length > 0 || !promptText.trim()}
        >
          <SendIcon data-icon="inline-start" />
          {pendingPermissions.length > 0
            ? "Permission required"
            : isProcessing
              ? "Processing..."
              : "Send"}
        </Button>
      </div>
    </Tabs>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Vertical Split Panel ────────────────────────────────────────────────────

function VerticalSplitPanel({
  topContent,
  bottomContent,
  defaultTopPercent = 55,
}: {
  topContent: React.ReactNode;
  bottomContent: React.ReactNode;
  defaultTopPercent?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [topPercent, setTopPercent] = useState(defaultTopPercent);
  const draggingRef = useRef(false);

  const handleMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;

    const onMouseMove = (ev: globalThis.MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const y = ev.clientY - rect.top;
      const pct = Math.min(Math.max((y / rect.height) * 100, 15), 85);
      setTopPercent(pct);
      window.dispatchEvent(new Event("resize"));
    };

    const onMouseUp = () => {
      draggingRef.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.dispatchEvent(new Event("resize"));
    };

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <div ref={containerRef} className="flex h-full flex-col border-l overflow-hidden">
      {/* Top section */}
      <div className="flex min-h-0 flex-col overflow-hidden" style={{ height: `${topPercent}%` }}>
        {topContent}
      </div>

      {/* Drag handle */}
      <div
        className="flex h-2 shrink-0 cursor-row-resize items-center justify-center border-y bg-muted/30 hover:bg-muted/60 transition-colors"
        onMouseDown={handleMouseDown}
      >
        <GripHorizontalIcon className="size-3 text-muted-foreground" />
      </div>

      {/* Bottom section */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{bottomContent}</div>
    </div>
  );
}
