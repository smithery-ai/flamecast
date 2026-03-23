import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchSession } from "@/client/lib/api";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import { sessionLogsToSegments } from "@/client/lib/logs-markdown";
import { Fragment, useEffect, useMemo, useState } from "react";
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
import { Skeleton } from "@/client/components/ui/skeleton";
import { Switch } from "@/client/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/client/components/ui/tabs";
import { Streamdown } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  FileCode2Icon,
  FolderTreeIcon,
  SendIcon,
} from "lucide-react";
/* oxlint-disable no-type-assertion/no-type-assertion */
import type { FileSystemEntry, PendingPermission, SessionLog } from "../../shared/session";
import { useFlamecastSession } from "@/client/hooks/use-flamecast-session";

export const Route = createFileRoute("/sessions/$id")({
  component: SessionDetailPage,
});

type TreeNode = {
  name: string;
  path: string;
  type: FileSystemEntry["type"];
  children: TreeNode[];
};

function SessionDetailPage() {
  const { id } = Route.useParams();
  const [prompt, setPrompt] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [isSending, setIsSending] = useState(false);

  // WebSocket-based session events and control
  const {
    events: wsEvents,
    isConnected,
    prompt: wsPrompt,
    respondToPermission: wsRespondToPermission,
    requestFilePreview,
  } = useFlamecastSession(id);

  // REST for initial session metadata and file system
  const { data: session, isLoading } = useQuery({
    queryKey: ["session", id, showAllFiles],
    queryFn: () => fetchSession(id, { includeFileSystem: true, showAllFiles }),
    staleTime: Infinity, // WS handles real-time updates
  });

  // Merge: use WS events if available, fall back to REST logs
  const logs: SessionLog[] = useMemo(() => {
    if (wsEvents.length > 0) return [...wsEvents];
    return session?.logs ?? [];
  }, [wsEvents, session?.logs]);

  // Derive pending permission from WS events
  const pendingPermission = useMemo(() => {
    for (let i = wsEvents.length - 1; i >= 0; i--) {
      const event = wsEvents[i];
      // Permission was resolved
      if (
        event.type === "permission_approved" ||
        event.type === "permission_rejected" ||
        event.type === "permission_cancelled" ||
        event.type === "permission_responded"
      ) {
        return null;
      }
      // Permission request from bridge event
      if (event.type === "permission_request" && event.data.pendingPermission) {
        return event.data.pendingPermission as PendingPermission;
      }
      // Permission request from RPC passthrough
      if (
        event.type === "rpc" &&
        event.data.method === "session/request_permission" &&
        event.data.direction === "agent_to_client" &&
        event.data.phase === "request"
      ) {
        // The bridge also emits a permission_request event with structured data,
        // so this is a fallback — extract what we can from the RPC payload
        const payload = event.data.payload as Record<string, unknown> | undefined;
        if (payload) {
          return (payload as { pendingPermission?: PendingPermission }).pendingPermission ?? null;
        }
      }
    }
    return session?.pendingPermission ?? null;
  }, [wsEvents, session?.pendingPermission]);

  // Derive file system data from WS filesystem events, fall back to REST
  const { fileEntries, workspaceRoot } = useMemo(() => {
    // Walk backwards to find latest filesystem.snapshot
    for (let i = wsEvents.length - 1; i >= 0; i--) {
      const event = wsEvents[i];
      if (event.type === "filesystem.snapshot" && event.data.snapshot) {
        const snapshot = event.data.snapshot as { root?: string; entries?: FileSystemEntry[] };
        return {
          fileEntries: snapshot.entries ?? [],
          workspaceRoot: snapshot.root ?? null,
        };
      }
    }
    return {
      fileEntries: session?.fileSystem?.entries ?? [],
      workspaceRoot: session?.fileSystem?.root ?? null,
    };
  }, [wsEvents, session?.fileSystem?.entries, session?.fileSystem?.root]);
  const fileEntryMap = useMemo(
    () => new Map(fileEntries.map((entry) => [entry.path, entry])),
    [fileEntries],
  );
  const fileTree = useMemo(() => buildTree(fileEntries), [fileEntries]);
  const markdownSegments = useMemo(() => sessionLogsToSegments(logs), [logs]);

  useEffect(() => {
    setExpandedPaths((current) => (current.size > 0 ? current : getInitialExpandedPaths(fileTree)));
  }, [fileTree]);

  useEffect(() => {
    if (selectedPath && fileEntryMap.get(selectedPath)?.type === "file") {
      return;
    }

    const firstFile = fileEntries.find((entry) => entry.type === "file");
    setSelectedPath(firstFile?.path ?? null);
  }, [fileEntries, fileEntryMap, selectedPath]);

  const selectedEntry = selectedPath ? (fileEntryMap.get(selectedPath) ?? null) : null;

  // File preview via WebSocket
  const [filePreview, setFilePreview] = useState<{ content: string; truncated: boolean } | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);

  useEffect(() => {
    if (!selectedPath || !selectedEntry || selectedEntry.type !== "file" || !isConnected) {
      setFilePreview(null);
      return;
    }
    let cancelled = false;
    setFilePreviewLoading(true);
    requestFilePreview(selectedPath)
      .then((result) => {
        if (!cancelled) {
          setFilePreview({ content: result.content, truncated: result.truncated });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFilePreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) setFilePreviewLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedPath, selectedEntry, isConnected, requestFilePreview]);

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

  const handleTreeSelect = (path: string) => {
    setSelectedPath(path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      for (const parentPath of getParentPaths(path)) {
        next.add(parentPath);
      }
      const entry = fileEntryMap.get(path);
      if (entry?.type === "directory") {
        next.add(path);
      }
      return next;
    });
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
            <Badge variant="outline" className="text-green-600">WS</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">SSE</Badge>
          )}
        </div>
      </div>

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
                {pendingPermission ? (
                  <Card className="max-w-2xl border-primary/50 bg-primary/5">
                    <CardHeader>
                      <CardTitle className="text-base">Permission required</CardTitle>
                      <CardDescription>
                        {pendingPermission.title}
                        {pendingPermission.kind ? (
                          <Badge variant="outline" className="ml-2">
                            {pendingPermission.kind}
                          </Badge>
                        ) : null}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2">
                      {(() => {
                        const pending = pendingPermission;
                        return (
                          <>
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
                          </>
                        );
                      })()}
                    </CardContent>
                  </Card>
                ) : null}
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
          <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
            <aside className="flex w-96 shrink-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
              <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
                <FolderTreeIcon className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Files</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {workspaceRoot ?? "No workspace root"}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <span>Show all</span>
                  <Switch
                    aria-label="Show ignored files"
                    checked={showAllFiles}
                    onCheckedChange={setShowAllFiles}
                    size="sm"
                  />
                </label>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-3">
                {fileTree.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No filesystem entries returned.
                  </p>
                ) : (
                  <FileTree
                    className="border-none bg-transparent"
                    expanded={expandedPaths}
                    onExpandedChange={setExpandedPaths}
                    onSelect={handleTreeSelect}
                    selectedPath={selectedPath ?? undefined}
                  >
                    {renderTree(fileTree)}
                  </FileTree>
                )}
              </div>
            </aside>

            <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
              <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
                <FileCode2Icon className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {selectedPath ?? "Select a file to preview"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {selectedEntry?.type === "file"
                      ? "Previewing current workspace file"
                      : "Select a file from the tree"}
                  </p>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {!selectedEntry ? (
                  <EmptyPreview message="No file selected." />
                ) : selectedEntry.type !== "file" ? (
                  <EmptyPreview message="Select a file to preview its contents." />
                ) : filePreviewLoading ? (
                  <EmptyPreview message="Loading..." />
                ) : filePreview ? (
                  <pre className="whitespace-pre-wrap break-all p-4 text-xs font-mono">
                    {filePreview.content}
                    {filePreview.truncated && (
                      <span className="text-muted-foreground">{"\n\n--- File truncated ---"}</span>
                    )}
                  </pre>
                ) : (
                  <EmptyPreview message="Could not load file preview." />
                )}
              </div>
            </section>
          </div>
        </TabsContent>
      </Tabs>

      <div className="flex shrink-0 flex-col gap-2 pt-4">
        <div className="flex gap-2 p-1">
          <Input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && handleSend()}
            placeholder="Send a prompt to the agent..."
            disabled={isSending || !!pendingPermission}
          />
          <Button
            onClick={handleSend}
            disabled={isSending || !!pendingPermission || !prompt.trim()}
          >
            <SendIcon data-icon="inline-start" />
            {pendingPermission
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

function EmptyPreview({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-[20rem] items-center justify-center p-6 text-sm text-muted-foreground">
      {message}
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

function renderTree(nodes: TreeNode[]) {
  return nodes.map((node) =>
    node.type === "directory" ? (
      <FileTreeFolder key={node.path} name={node.name} path={node.path}>
        {renderTree(node.children)}
      </FileTreeFolder>
    ) : (
      <FileTreeFile key={node.path} name={node.name} path={node.path} />
    ),
  );
}

function buildTree(entries: FileSystemEntry[]): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: "",
    type: "directory",
    children: [],
  };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let current = root;

    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      let child = current.children.find((candidate) => candidate.path === path);

      if (!child) {
        child = {
          name: segment,
          path,
          type: index === segments.length - 1 ? entry.type : "directory",
          children: [],
        };
        current.children.push(child);
      }

      if (index === segments.length - 1) {
        child.type = entry.type;
      }

      current = child;
    });
  }

  sortTree(root.children);
  return root.children;
}

function sortTree(nodes: TreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });

  nodes.forEach((node) => {
    if (node.children.length > 0) {
      sortTree(node.children);
    }
  });
}

function getInitialExpandedPaths(nodes: TreeNode[]) {
  return new Set(nodes.filter((node) => node.type === "directory").map((node) => node.path));
}

function getParentPaths(path: string) {
  const segments = path.split("/").filter(Boolean);
  const parents: string[] = [];

  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }

  return parents;
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
