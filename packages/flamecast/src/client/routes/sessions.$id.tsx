import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchFilePreview, fetchSession, respondToPermission, sendPrompt } from "@/client/lib/api";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import { sessionLogsToSegments } from "@/client/lib/logs-markdown";
import { buildDiffLines } from "@/client/lib/tool-call-diffs";
import { cn } from "@/client/lib/utils";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/client/components/ui/collapsible";
import { Streamdown } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  FileCode2Icon,
  FolderTreeIcon,
  SendIcon,
} from "lucide-react";
import type { FileSystemEntry, PendingPermission, SessionDiff } from "../../shared/session";

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
  const [expandedHistoricalToolCallIds, setExpandedHistoricalToolCallIds] = useState<Set<string>>(
    new Set(),
  );
  const [collapsedCurrentToolCallIds, setCollapsedCurrentToolCallIds] = useState<Set<string>>(
    new Set(),
  );
  const [showAllFiles, setShowAllFiles] = useState(false);
  const queryClient = useQueryClient();

  const { data: session, isLoading } = useQuery({
    queryKey: ["session", id, showAllFiles],
    queryFn: () => fetchSession(id, { includeFileSystem: true, showAllFiles }),
    refetchInterval: 1000,
  });

  const promptMutation = useMutation({
    mutationFn: (text: string) => sendPrompt(id, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["session", id] });
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
      queryClient.invalidateQueries({ queryKey: ["session", id] });
    },
  });

  const fileEntries = session?.fileSystem?.entries ?? [];
  const fileEntryMap = useMemo(
    () => new Map(fileEntries.map((entry) => [entry.path, entry])),
    [fileEntries],
  );
  const fileTree = useMemo(() => buildTree(fileEntries), [fileEntries]);
  const markdownSegments = useMemo(
    () => sessionLogsToSegments(session?.logs ?? []),
    [session?.logs],
  );
  const renderableToolSegments = useMemo(
    () =>
      markdownSegments.filter(
        (segment) =>
          segment.kind === "tool" &&
          !shouldHidePendingToolCall(
            segment.toolCallId,
            segment.status,
            session?.pendingPermission,
          ),
      ),
    [markdownSegments, session?.pendingPermission],
  );
  const renderableToolCallIds = useMemo(
    () => renderableToolSegments.map((segment) => segment.toolCallId).filter(Boolean),
    [renderableToolSegments],
  );
  const latestVisibleToolCallId = session?.pendingPermission
    ? null
    : (renderableToolSegments.at(-1)?.toolCallId ?? null);

  useEffect(() => {
    setExpandedPaths((current) => (current.size > 0 ? current : getInitialExpandedPaths(fileTree)));
  }, [fileTree]);

  useEffect(() => {
    const visibleToolCallIds = new Set(renderableToolCallIds);
    setExpandedHistoricalToolCallIds((current) => filterToolCallIds(current, visibleToolCallIds));
    setCollapsedCurrentToolCallIds((current) => filterToolCallIds(current, visibleToolCallIds));
  }, [renderableToolCallIds]);

  useEffect(() => {
    if (selectedPath && fileEntryMap.get(selectedPath)?.type === "file") {
      return;
    }

    const firstFile = fileEntries.find((entry) => entry.type === "file");
    setSelectedPath(firstFile?.path ?? null);
  }, [fileEntries, fileEntryMap, selectedPath]);

  const selectedEntry = selectedPath ? (fileEntryMap.get(selectedPath) ?? null) : null;

  const previewQuery = useQuery({
    queryKey: ["session-file-preview", id, selectedPath],
    queryFn: () => {
      if (!selectedPath) {
        throw new Error("No file selected");
      }
      return fetchFilePreview(id, selectedPath);
    },
    enabled: Boolean(selectedPath && selectedEntry?.type === "file"),
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
                      promptMutation.isPending &&
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
                      if (
                        shouldHidePendingToolCall(
                          seg.toolCallId,
                          seg.status,
                          session.pendingPermission,
                        )
                      ) {
                        return null;
                      }
                      const isHistoricalToolCall =
                        latestVisibleToolCallId == null ||
                        seg.toolCallId !== latestVisibleToolCallId;
                      const isExpanded = isHistoricalToolCall
                        ? expandedHistoricalToolCallIds.has(seg.toolCallId)
                        : !collapsedCurrentToolCallIds.has(seg.toolCallId);
                      return (
                        <Fragment key={seg.toolCallId || index}>
                          {index > 0 ? <Separator /> : null}
                          <ToolCallCard
                            toolCallId={seg.toolCallId}
                            title={seg.title}
                            status={seg.status}
                            diffs={seg.diffs}
                            workspaceRoot={session.fileSystem?.root}
                            expanded={isExpanded}
                            onExpandedChange={(open) => {
                              if (isHistoricalToolCall) {
                                setExpandedHistoricalToolCallIds((current) =>
                                  updateToolCallIdSet(current, seg.toolCallId, open),
                                );
                                return;
                              }
                              setCollapsedCurrentToolCallIds((current) =>
                                updateToolCallIdSet(current, seg.toolCallId, !open),
                              );
                            }}
                          />
                        </Fragment>
                      );
                    }
                    return null;
                  })
                )}
                {session.pendingPermission ? (
                  <Card className="max-w-2xl border-primary/50 bg-primary/5">
                    <CardHeader>
                      <CardTitle className="text-base">Permission required</CardTitle>
                      <CardDescription>
                        {session.pendingPermission.title}
                        {session.pendingPermission.kind ? (
                          <Badge variant="outline" className="ml-2">
                            {session.pendingPermission.kind}
                          </Badge>
                        ) : null}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {(session.pendingPermission.diffs?.length ?? 0) > 0 ? (
                        <ProposedDiffList
                          diffs={session.pendingPermission.diffs ?? []}
                          workspaceRoot={session.fileSystem?.root}
                        />
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        {(() => {
                          const pending = session.pendingPermission;
                          return (
                            <>
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
                            </>
                          );
                        })()}
                      </div>
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
                {session.logs.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No logs yet. Send a prompt to get started.
                  </p>
                ) : (
                  session.logs.map((log, index) => (
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
                    {session.fileSystem?.root ?? "No workspace root"}
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
                {!session.fileSystem || fileTree.length === 0 ? (
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
                ) : previewQuery.isLoading ? (
                  <div className="space-y-3 p-4">
                    <Skeleton className="h-5 w-48" />
                    <Skeleton className="h-64 w-full" />
                  </div>
                ) : previewQuery.isError ? (
                  <EmptyPreview message="Failed to load file preview." />
                ) : (
                  <div className="flex min-h-full flex-col">
                    <pre className="min-h-full overflow-auto whitespace-pre-wrap break-words bg-muted/30 p-4 font-mono text-xs leading-6 text-foreground">
                      {previewQuery.data?.content ?? ""}
                    </pre>
                    {previewQuery.data?.truncated ? (
                      <div className="border-t px-4 py-2 text-xs text-muted-foreground">
                        Preview truncated at {previewQuery.data.maxChars.toLocaleString()}{" "}
                        characters.
                      </div>
                    ) : null}
                  </div>
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
            disabled={promptMutation.isPending || !!session.pendingPermission}
          />
          <Button
            onClick={handleSend}
            disabled={promptMutation.isPending || !!session.pendingPermission || !prompt.trim()}
          >
            <SendIcon data-icon="inline-start" />
            {session.pendingPermission
              ? "Permission required"
              : promptMutation.isPending
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

function ToolCallCard({
  toolCallId,
  title,
  status,
  diffs,
  workspaceRoot,
  expanded,
  onExpandedChange,
}: {
  toolCallId: string;
  title: string;
  status: string;
  diffs: SessionDiff[];
  workspaceRoot?: string;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
}) {
  const hasDiffs = diffs.length > 0;

  return (
    <Collapsible
      open={hasDiffs ? expanded : true}
      onOpenChange={hasDiffs ? onExpandedChange : undefined}
    >
      <Card className="border-border/70 bg-muted/20">
        <CardHeader className="gap-2 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <CardTitle className="text-sm font-medium">{title}</CardTitle>
              {hasDiffs ? (
                <CardDescription className="text-xs">
                  {expanded ? "Diff visible" : "Diff hidden"}
                </CardDescription>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {status ? (
                <Badge variant={status === "completed" ? "default" : "outline"}>{status}</Badge>
              ) : null}
              {hasDiffs ? (
                <CollapsibleTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`${expanded ? "Hide" : "Show"} diff for ${toolCallId}`}
                  >
                    {expanded ? "Hide diff" : "Show diff"}
                    <ChevronDownIcon
                      className={cn("size-4 transition-transform", expanded && "rotate-180")}
                    />
                  </Button>
                </CollapsibleTrigger>
              ) : null}
            </div>
          </div>
        </CardHeader>
        {hasDiffs ? (
          <CollapsibleContent>
            <CardContent className="space-y-3 pt-0">
              <ProposedDiffList diffs={diffs} workspaceRoot={workspaceRoot} />
            </CardContent>
          </CollapsibleContent>
        ) : null}
      </Card>
    </Collapsible>
  );
}

function ProposedDiffList({
  diffs,
  workspaceRoot,
}: {
  diffs: SessionDiff[];
  workspaceRoot?: string;
}) {
  return (
    <div className="space-y-3">
      {diffs.map((diff) => (
        <DiffPreview
          key={`${diff.path}:${diff.newText.length}`}
          diff={diff}
          workspaceRoot={workspaceRoot}
        />
      ))}
    </div>
  );
}

function DiffPreview({ diff, workspaceRoot }: { diff: SessionDiff; workspaceRoot?: string }) {
  const lines = buildDiffLines(diff.oldText ?? null, diff.newText);
  const diffKind =
    diff.oldText == null ? "new file" : diff.newText.length === 0 ? "deleted" : "modified";

  return (
    <div className="overflow-hidden rounded-lg border border-border/70">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2">
        <code className="text-xs text-foreground">
          {formatWorkspacePath(diff.path, workspaceRoot)}
        </code>
        <Badge variant="outline">{diffKind}</Badge>
      </div>
      {lines.length === 0 ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">No textual changes.</div>
      ) : (
        <div className="overflow-auto">
          <div className="min-w-full font-mono text-xs leading-6">
            {lines.map((line, index) => (
              <div
                key={index}
                className={cn(
                  "grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 px-4",
                  line.kind === "add" && "bg-emerald-500/10 text-emerald-950 dark:text-emerald-100",
                  line.kind === "remove" && "bg-rose-500/10 text-rose-950 dark:text-rose-100",
                )}
              >
                <span className="select-none text-muted-foreground">
                  {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                </span>
                <span className="whitespace-pre-wrap break-all">{line.text || " "}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function updateToolCallIdSet(current: Set<string>, toolCallId: string, present: boolean) {
  const next = new Set(current);
  if (present) {
    next.add(toolCallId);
  } else {
    next.delete(toolCallId);
  }
  return areSetsEqual(current, next) ? current : next;
}

function filterToolCallIds(current: Set<string>, visibleToolCallIds: Set<string>) {
  const next = new Set([...current].filter((toolCallId) => visibleToolCallIds.has(toolCallId)));
  return areSetsEqual(current, next) ? current : next;
}

function areSetsEqual(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
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

function formatWorkspacePath(path: string, workspaceRoot?: string) {
  if (!workspaceRoot) {
    return path;
  }

  return path.startsWith(`${workspaceRoot}/`) ? path.slice(workspaceRoot.length + 1) : path;
}

function shouldHidePendingToolCall(
  toolCallId: string,
  status: string,
  pendingPermission: PendingPermission | null,
) {
  if (!pendingPermission) {
    return false;
  }

  return (
    pendingPermission.toolCallId === toolCallId &&
    (status === "pending" || status === "in_progress")
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
