import {
  useSessionState,
  useRuntimeFileSystem,
  useTerminal,
  useFlamecastClient,
  useIsMobile,
} from "@flamecast/ui";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { RuntimeFileTree } from "@/components/runtime-file-tree";
import { RuntimeFileTab } from "@/components/runtime-file-tab";
import { TerminalPanel } from "@/components/terminal-panel";
import { Streamdown } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ChevronDownIcon, LoaderCircleIcon, GripHorizontalIcon } from "lucide-react";
import { SlashCommandInput } from "@/components/slash-command-input";

export function RuntimeSessionTab({
  sessionId,
  instanceName,
  runtimeWebsocketUrl,
  cwd,
  initialPrompt,
  onOpenFileTab,
}: {
  sessionId: string;
  instanceName: string;
  runtimeWebsocketUrl?: string;
  /** Initial working directory — used to load the file tree immediately. */
  cwd?: string;
  initialPrompt?: string;
  onOpenFileTab?: (filePath: string) => void;
}) {
  const client = useFlamecastClient();

  const fetchCommands = useCallback(
    () =>
      client.rpc.agents[":agentId"].commands
        .$get({ param: { agentId: sessionId } })
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => (Array.isArray(data) ? data : [])),
    [client, sessionId],
  );

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

  // Filesystem state — uses the runtime filesystem API so it loads immediately,
  // without waiting for the session to be created on the server.
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [fsPath, setFsPath] = useState<string | undefined>(cwd);

  const fsQuery = useRuntimeFileSystem(instanceName, {
    showAllFiles,
    path: fsPath,
  });

  // Session-scoped terminal (connects to the runtime instance, scoped to this session)
  const { terminals, sendInput, resize, onData, createTerminal, killTerminal } =
    useTerminal(runtimeWebsocketUrl, sessionId);

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

  // Always render the full layout — each panel handles its own loading state.
  // Chat shows a skeleton while the session initializes, filesystem has its own
  // loading spinner, and the terminal connects to the runtime immediately.

  const isMobile = useIsMobile();

  const filesystemContent = fsQuery.isLoading ? (
    <FilesystemSkeleton />
  ) : fsQuery.isError || !fsQuery.data ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
      <p className="text-xs text-muted-foreground">Could not load filesystem</p>
      <Button variant="outline" size="sm" onClick={() => void fsQuery.refetch()}>
        Retry
      </Button>
    </div>
  ) : (
    <RuntimeFileTree
      workspaceRoot={fsQuery.data.root}
      currentPath={fsQuery.data.path ?? fsQuery.data.root}
      entries={fsQuery.data.entries}
      showAllFiles={showAllFiles}
      onShowAllFilesChange={setShowAllFiles}
      onFileSelect={handleFileSelect}
      onNavigate={setFsPath}
    />
  );

  const terminalContent = (
    <TerminalPanel
      terminals={terminals}
      sendInput={sendInput}
      resize={resize}
      onData={onData}
      onCreateTerminal={() => createTerminal()}
      onRemoveTerminal={killTerminal}
    />
  );

  const conversationContent = isLoading ? (
    <ChatSkeleton />
  ) : !session ? (
    <ChatConnecting />
  ) : (
    <SessionConversation
      fetchCommands={fetchCommands}
      prompt={prompt}
      logs={logs}
      markdownSegments={markdownSegments}
      isProcessing={isProcessing}
      pendingPermissions={pendingPermissions}
      respondToPermission={respondToPermission}
      previewFilePath={previewFilePath}
      onClosePreview={() => setPreviewFilePath(null)}
      loadPreview={loadPreview}
    />
  );

  // On mobile, merge filesystem & terminal into tabs alongside Markdown/Traces
  if (isMobile) {
    return (
      <MobileSessionLayout
        filesystemContent={filesystemContent}
        terminalContent={terminalContent}
        fetchCommands={fetchCommands}
        prompt={prompt}
        isProcessing={isProcessing}
        pendingPermissions={pendingPermissions}
        logs={logs}
        markdownSegments={markdownSegments}
        respondToPermission={respondToPermission}
        previewFilePath={previewFilePath}
        onClosePreview={() => setPreviewFilePath(null)}
        loadPreview={loadPreview}
        isLoading={isLoading}
        session={session}
      />
    );
  }

  return (
    <ResizablePanelGroup className="min-h-0 flex-1">
      {/* Left: Conversation */}
      <ResizablePanel defaultSize={65} minSize={30}>
        <div className="flex h-full min-h-0 flex-col overflow-hidden">{conversationContent}</div>
      </ResizablePanel>

      <ResizableHandle />

      {/* Right: Filesystem + Terminal (session-scoped) */}
      <ResizablePanel defaultSize={35} minSize={20}>
        <VerticalSplitPanel topContent={filesystemContent} bottomContent={terminalContent} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

// ─── Loading States ──────────────────────────────────────────────────────────

function ChatSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="h-5 w-56" />
      <Skeleton className="h-32 w-full rounded-lg" />
      <div className="mt-auto" />
      <Skeleton className="h-8 w-full rounded-md" />
    </div>
  );
}

function ChatConnecting() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
      <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Starting session...</p>
    </div>
  );
}

function FilesystemSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-3">
      <Skeleton className="h-4 w-32" />
      <div className="flex flex-col gap-1 pt-2">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="size-4 shrink-0 rounded" />
            <Skeleton className="h-3.5" style={{ width: `${40 + Math.random() * 60}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Mobile Layout ───────────────────────────────────────────────────────────

/**
 * On mobile, filesystem and terminal are shown as tabs alongside Markdown/Traces
 * instead of as resizable side panels.
 */
function MobileSessionLayout({
  filesystemContent,
  terminalContent,
  fetchCommands,
  prompt,
  isProcessing,
  pendingPermissions,
  respondToPermission,
  logs,
  markdownSegments,
  previewFilePath,
  onClosePreview,
  loadPreview,
  isLoading,
  session,
}: {
  filesystemContent: ReactNode;
  terminalContent: ReactNode;
  fetchCommands: () => Promise<{ name: string; description: string }[]>;
  prompt: (text: string) => void;
  isProcessing: boolean;
  pendingPermissions: ReturnType<typeof useSessionState>["pendingPermissions"];
  respondToPermission: ReturnType<typeof useSessionState>["respondToPermission"];
  logs: ReturnType<typeof useSessionState>["logs"];
  markdownSegments: ReturnType<typeof useSessionState>["markdownSegments"];
  previewFilePath: string | null;
  onClosePreview: () => void;
  loadPreview: (path: string) => Promise<{ content: string; truncated: boolean }>;
  isLoading: boolean;
  session: ReturnType<typeof useSessionState>["session"];
}) {
  // When the session hasn't loaded yet, show loading/connecting state directly
  if (isLoading) return <ChatSkeleton />;
  if (!session) return <ChatConnecting />;

  // If a file is being previewed inline, delegate to SessionConversation which handles it
  if (previewFilePath) {
    return (
      <SessionConversation
        fetchCommands={fetchCommands}
        prompt={prompt}
        logs={logs}
        markdownSegments={markdownSegments}
        isProcessing={isProcessing}
        pendingPermissions={pendingPermissions}
        respondToPermission={respondToPermission}
        previewFilePath={previewFilePath}
        onClosePreview={onClosePreview}
        loadPreview={loadPreview}
      />
    );
  }

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
          <TabsTrigger value="files" className="text-xs px-2 py-0.5">
            Files
          </TabsTrigger>
          <TabsTrigger value="terminal" className="text-xs px-2 py-0.5">
            Terminal
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

      <TabsContent value="files" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
        {filesystemContent}
      </TabsContent>

      <TabsContent value="terminal" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
        {terminalContent}
      </TabsContent>

      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2">
        <SlashCommandInput
          fetchCommands={fetchCommands}
          onSend={prompt}
          disabled={isProcessing || pendingPermissions.length > 0}
          placeholder={
            pendingPermissions.length > 0
              ? "Permission required…"
              : isProcessing
                ? "Processing…"
                : "Send a prompt to the agent…"
          }
        />
      </div>
    </Tabs>
  );
}

// ─── Conversation Panel ───────────────────────────────────────────────────────

function SessionConversation({
  fetchCommands,
  prompt,
  logs,
  markdownSegments,
  isProcessing,
  pendingPermissions,
  respondToPermission,
  previewFilePath,
  onClosePreview,
  loadPreview,
}: {
  fetchCommands: () => Promise<{ name: string; description: string }[]>;
  prompt: (text: string) => void;
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
        <SlashCommandInput
          fetchCommands={fetchCommands}
          onSend={prompt}
          disabled={isProcessing || pendingPermissions.length > 0}
          placeholder={
            pendingPermissions.length > 0
              ? "Permission required…"
              : isProcessing
                ? "Processing…"
                : "Send a prompt to the agent…"
          }
        />
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
  topContent: ReactNode;
  bottomContent: ReactNode;
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
