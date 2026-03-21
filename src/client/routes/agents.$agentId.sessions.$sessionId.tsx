import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchFilePreview, fetchSession } from "@/client/lib/api";
import { AgentAcpClient } from "@/client/lib/agent-acp";
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
import { ArrowLeftIcon, FileCode2Icon, FolderTreeIcon, SendIcon } from "lucide-react";
import type { FileSystemEntry } from "../../shared/session";

export const Route = createFileRoute("/agents/$agentId/sessions/$sessionId")({
  component: SessionDetailPage,
});

type TreeNode = {
  name: string;
  path: string;
  type: FileSystemEntry["type"];
  children: TreeNode[];
};

function SessionDetailPage() {
  const { agentId, sessionId } = Route.useParams();
  const [prompt, setPrompt] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [acpClient] = useState(() => new AgentAcpClient(agentId));
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await acpClient.connect();
        if (cancelled) return;
        await acpClient.loadSession(sessionId, ".");
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to attach ACP session", error);
        }
      }
    })();

    return () => {
      cancelled = true;
      void acpClient.close();
    };
  }, [acpClient, sessionId]);

  const { data: session, isLoading } = useQuery({
    queryKey: ["session", agentId, sessionId, showAllFiles],
    queryFn: () => fetchSession(agentId, sessionId, { includeFileSystem: true, showAllFiles }),
    refetchInterval: 1000,
  });

  const promptMutation = useMutation({
    mutationFn: (text: string) => acpClient.prompt(sessionId, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["session", agentId, sessionId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const permissionMutation = useMutation({
    mutationFn: (body: { optionId: string } | { outcome: "cancelled" }) =>
      acpClient.respondToPermission(sessionId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["session", agentId, sessionId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
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

  useEffect(() => {
    setExpandedPaths((current) => {
      if (current.size > 0) {
        return current;
      }

      const initial = getInitialExpandedPaths(fileTree);
      return initial.size > 0 ? initial : current;
    });
  }, [fileTree]);

  useEffect(() => {
    const nextPath =
      selectedPath && fileEntryMap.get(selectedPath)?.type === "file"
        ? selectedPath
        : (fileEntries.find((entry) => entry.type === "file")?.path ?? null);

    setSelectedPath((current) => (current === nextPath ? current : nextPath));
  }, [fileEntries, fileEntryMap, selectedPath]);

  const selectedEntry = selectedPath ? (fileEntryMap.get(selectedPath) ?? null) : null;

  const previewQuery = useQuery({
    queryKey: ["session-file-preview", agentId, sessionId, selectedPath],
    queryFn: () => {
      if (!selectedPath) {
        throw new Error("No file selected");
      }
      return fetchFilePreview(agentId, sessionId, selectedPath);
    },
    enabled: Boolean(selectedPath && selectedEntry?.type === "file"),
  });

  const handlePermission = (body: { optionId: string } | { outcome: "cancelled" }) => {
    permissionMutation.mutate(body);
  };

  const handleSend = () => {
    if (!prompt.trim()) return;
    promptMutation.mutate(prompt);
    setPrompt("");
  };

  const handleTreeSelect = (path: string) => {
    setSelectedPath(path);
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
            Back to templates
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
                      const toolMd = `**Tool:** ${seg.title}${seg.status ? ` - \`${seg.status}\`` : ""}`;
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
                    <CardContent className="flex flex-wrap gap-2">
                      {session.pendingPermission.options.map((opt) => (
                        <Button
                          key={opt.optionId}
                          variant={opt.kind === "allow_once" ? "default" : "secondary"}
                          size="sm"
                          disabled={permissionMutation.isPending}
                          onClick={() => handlePermission({ optionId: opt.optionId })}
                        >
                          {opt.name}
                        </Button>
                      ))}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={permissionMutation.isPending}
                        onClick={() => handlePermission({ outcome: "cancelled" })}
                      >
                        Cancel
                      </Button>
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
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{log.type}</div>
                          <pre className="mt-1 overflow-x-auto rounded bg-muted p-3 text-xs">
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

        <TabsContent value="files" className="mt-0 flex min-h-0 flex-1 overflow-hidden">
          <section className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[280px_minmax(0,1fr)]">
            <Card className="min-h-0 overflow-hidden">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <FolderTreeIcon className="h-4 w-4" />
                  Workspace
                </CardTitle>
                <CardDescription className="flex items-center justify-between gap-3">
                  <span>{session.fileSystem?.root ?? "No workspace snapshot available"}</span>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch checked={showAllFiles} onCheckedChange={setShowAllFiles} />
                    Show all
                  </label>
                </CardDescription>
              </CardHeader>
              <CardContent className="min-h-0 overflow-auto pb-4">
                {fileTree.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No files available.</p>
                ) : (
                  <FileTree
                    expanded={expandedPaths}
                    selectedPath={selectedPath ?? undefined}
                    onSelect={handleTreeSelect}
                    onExpandedChange={setExpandedPaths}
                  >
                    {fileTree.map((node) => (
                      <FileTreeNode key={node.path} node={node} selectedPath={selectedPath} />
                    ))}
                  </FileTree>
                )}
              </CardContent>
            </Card>

            <Card className="min-h-0 overflow-hidden">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileCode2Icon className="h-4 w-4" />
                  {selectedPath ?? "Select a file"}
                </CardTitle>
                {previewQuery.data ? (
                  <CardDescription>
                    {previewQuery.data.truncated
                      ? `Preview truncated to ${previewQuery.data.maxChars.toLocaleString()} characters.`
                      : "Full file preview."}
                  </CardDescription>
                ) : null}
              </CardHeader>
              <CardContent className="min-h-0 overflow-auto pb-4">
                {!selectedPath ? (
                  <p className="text-sm text-muted-foreground">
                    Select a file from the tree to inspect it here.
                  </p>
                ) : previewQuery.isLoading ? (
                  <Skeleton className="h-48 w-full rounded-lg" />
                ) : previewQuery.isError ? (
                  <p className="text-sm text-destructive">Failed to load preview.</p>
                ) : previewQuery.data ? (
                  <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs leading-6">
                    {previewQuery.data.content}
                  </pre>
                ) : null}
              </CardContent>
            </Card>
          </section>
        </TabsContent>
      </Tabs>

      <div className="mt-4 shrink-0 rounded-xl border border-border/70 bg-card p-3">
        <div className="flex items-center gap-2">
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Send a prompt..."
            disabled={promptMutation.isPending}
          />
          <Button onClick={handleSend} disabled={promptMutation.isPending || !prompt.trim()}>
            <SendIcon data-icon="inline-start" />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function FileTreeNode({ node, selectedPath }: { node: TreeNode; selectedPath: string | null }) {
  if (node.type === "directory") {
    return (
      <FileTreeFolder path={node.path} name={node.name}>
        {node.children.map((child) => (
          <FileTreeNode key={child.path} node={child} selectedPath={selectedPath} />
        ))}
      </FileTreeFolder>
    );
  }

  return (
    <FileTreeFile path={node.path} name={node.name}>
      <button
        type="button"
        className={`w-full rounded-md px-2 py-1 text-left text-sm hover:bg-muted ${
          selectedPath === node.path ? "bg-muted font-medium" : ""
        }`}
      >
        {node.name}
      </button>
    </FileTreeFile>
  );
}

function buildTree(entries: FileSystemEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  for (const entry of entries) {
    const segments = entry.path.split("/");
    const name = segments[segments.length - 1] ?? entry.path;
    const node: TreeNode = {
      name,
      path: entry.path,
      type: entry.type,
      children: [],
    };
    byPath.set(entry.path, node);

    const parentPath = segments.slice(0, -1).join("/");
    if (!parentPath) {
      root.push(node);
      continue;
    }

    const parent = byPath.get(parentPath);
    if (parent) {
      parent.children.push(node);
    }
  }

  return root;
}

function getInitialExpandedPaths(nodes: TreeNode[]): Set<string> {
  const expanded = new Set<string>();

  for (const node of nodes) {
    if (node.type === "directory") {
      expanded.add(node.path);
      break;
    }
  }

  return expanded;
}

function StickToBottomFab() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) return null;

  return (
    <div className="absolute bottom-4 right-4">
      <Button size="sm" variant="secondary" onClick={() => scrollToBottom()}>
        Jump to latest
      </Button>
    </div>
  );
}
