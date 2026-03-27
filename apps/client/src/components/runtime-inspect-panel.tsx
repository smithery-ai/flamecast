import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { execOnRuntime, fetchRuntimeFile, fetchRuntimeFsSnapshot, fetchSessions } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { XtermTerminal, type XtermTerminalHandle } from "@/components/xterm-terminal";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import {
  FileCode2Icon,
  FolderTreeIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
  ActivityIcon,
  PowerOffIcon,
  SkullIcon,
} from "lucide-react";
import type { RuntimeInstance } from "@flamecast/protocol/runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TerminalTab {
  id: string;
  label: string;
  /** "running" | "closing" | "closed" */
  state: "running" | "closing" | "closed";
}

interface RuntimeInspectPanelProps {
  instance: RuntimeInstance;
  onStart?: () => void;
  isStarting?: boolean;
}

type TreeNode = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  children: TreeNode[];
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RuntimeInspectPanel({
  instance,
  onStart,
  isStarting,
}: RuntimeInspectPanelProps) {
  const isRunning = instance.status === "running";

  if (!isRunning) {
    return <InactiveRuntimeView instance={instance} onStart={onStart} isStarting={isStarting} />;
  }

  return <ActiveRuntimeView instance={instance} />;
}

// ---------------------------------------------------------------------------
// Inactive view
// ---------------------------------------------------------------------------

function InactiveRuntimeView({
  instance,
  onStart,
  isStarting,
}: {
  instance: RuntimeInstance;
  onStart?: () => void;
  isStarting?: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-muted">
        <PowerOffIcon className="size-7 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">{instance.name}</h3>
        <p className="text-sm text-muted-foreground">
          This runtime instance is currently{" "}
          <Badge
            variant="outline"
            className={cn(
              instance.status === "paused"
                ? "text-yellow-700 dark:text-yellow-400"
                : "text-muted-foreground",
            )}
          >
            {instance.status}
          </Badge>
        </p>
      </div>
      {onStart && (
        <Button onClick={onStart} disabled={isStarting} className="mt-2">
          {isStarting ? (
            <LoaderCircleIcon className="size-4 animate-spin" />
          ) : (
            <PlayIcon className="size-4" />
          )}
          {instance.status === "paused" ? "Resume" : "Start"} instance
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active view — tabs: Filesystem | Terminal | Traces
// ---------------------------------------------------------------------------

function ActiveRuntimeView({ instance }: { instance: RuntimeInstance }) {
  const [activeTab, setActiveTab] = useState("filesystem");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <h3 className="truncate text-sm font-semibold">{instance.name}</h3>
        <Badge
          variant="outline"
          className="shrink-0 text-green-700 dark:text-green-400"
        >
          running
        </Badge>
      </div>

      {/* Tabbed content */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div className="shrink-0 border-b px-4 pt-2">
          <TabsList variant="line">
            <TabsTrigger value="filesystem">
              <FolderTreeIcon className="size-3.5" />
              Files
            </TabsTrigger>
            <TabsTrigger value="terminal">
              <TerminalIcon className="size-3.5" />
              Terminal
            </TabsTrigger>
            <TabsTrigger value="traces">
              <ActivityIcon className="size-3.5" />
              Traces
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="filesystem" className="mt-0 min-h-0 flex-1 overflow-hidden">
          <FilesystemTab instanceName={instance.name} />
        </TabsContent>

        <TabsContent value="terminal" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <TerminalTabsContainer instanceName={instance.name} />
        </TabsContent>

        <TabsContent value="traces" className="mt-0 min-h-0 flex-1 overflow-auto">
          <TracesTab instance={instance} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filesystem tab — uses runtime-level HTTP endpoints (not session-scoped)
// ---------------------------------------------------------------------------

function FilesystemTab({ instanceName }: { instanceName: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [filePreview, setFilePreview] = useState<{ content: string; truncated: boolean } | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);

  // Fetch filesystem snapshot at the runtime level
  const { data: fsSnapshot, isLoading } = useQuery({
    queryKey: ["runtime-fs", instanceName],
    queryFn: () => fetchRuntimeFsSnapshot(instanceName),
    refetchInterval: 15_000,
  });

  const fileEntries = fsSnapshot?.entries;
  const workspaceRoot = fsSnapshot?.root ?? null;
  const fileTree = useMemo(() => buildTree(fileEntries ?? []), [fileEntries]);

  useEffect(() => {
    if (!fileTree.length) return;
    setExpandedPaths((current) =>
      current.size > 0 ? current : getInitialExpandedPaths(fileTree),
    );
  }, [fileTree]);

  // File preview when selecting a file
  useEffect(() => {
    if (!selectedPath || !fileEntries) {
      setFilePreview(null);
      return;
    }
    const entry = fileEntries.find((e) => e.path === selectedPath);
    if (!entry || entry.type !== "file") {
      setFilePreview(null);
      return;
    }

    let cancelled = false;
    setFilePreviewLoading(true);
    fetchRuntimeFile(instanceName, selectedPath)
      .then((result) => {
        if (!cancelled) setFilePreview({ content: result.content, truncated: result.truncated });
      })
      .catch(() => {
        if (!cancelled) setFilePreview(null);
      })
      .finally(() => {
        if (!cancelled) setFilePreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, instanceName, fileEntries]);

  const handleTreeSelect = useCallback(
    (path: string) => {
      setSelectedPath(path);
      setExpandedPaths((current) => {
        const next = new Set(current);
        for (const parentPath of getParentPaths(path)) next.add(parentPath);
        const entry = fileEntries.find((e) => e.path === path);
        if (entry?.type === "directory") next.add(path);
        return next;
      });
    },
    [fileEntries],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!fileEntries || fileEntries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        <div className="space-y-2 text-center">
          <FolderTreeIcon className="mx-auto size-8 text-muted-foreground/50" />
          <p>No filesystem entries available.</p>
          <p className="text-xs">Start a session on this runtime to browse workspace files.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* File tree sidebar */}
      <aside className="flex w-64 shrink-0 flex-col overflow-hidden border-r">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <FolderTreeIcon className="size-3.5 text-muted-foreground" />
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {workspaceRoot ?? "workspace"}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <FileTree
            className="border-none bg-transparent"
            expanded={expandedPaths}
            onExpandedChange={setExpandedPaths}
            onSelect={handleTreeSelect}
            selectedPath={selectedPath ?? undefined}
          >
            {renderTree(fileTree)}
          </FileTree>
        </div>
      </aside>

      {/* File preview */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <FileCode2Icon className="size-3.5 text-muted-foreground" />
          <p className="min-w-0 flex-1 truncate text-xs font-medium">
            {selectedPath ?? "Select a file"}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {!selectedPath ? (
            <EmptyPreview message="Select a file to preview." />
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
            <EmptyPreview message="Could not load preview." />
          )}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal tabs — add / remove with graceful close + hard kill
// ---------------------------------------------------------------------------

let terminalCounter = 0;

function TerminalTabsContainer({ instanceName }: { instanceName: string }) {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => {
    terminalCounter++;
    return [
      {
        id: `term-${terminalCounter}`,
        label: `Terminal ${terminalCounter}`,
        state: "running",
      },
    ];
  });
  const [activeTerminal, setActiveTerminal] = useState<string>(tabs[0]?.id ?? "");
  const [closingTab, setClosingTab] = useState<TerminalTab | null>(null);

  const addTab = useCallback(() => {
    terminalCounter++;
    const newTab: TerminalTab = {
      id: `term-${terminalCounter}`,
      label: `Terminal ${terminalCounter}`,
      state: "running",
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTerminal(newTab.id);
  }, []);

  const removeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        // Also fix active terminal if needed
        setActiveTerminal((current) => {
          if (current === tabId) {
            return next[next.length - 1]?.id ?? "";
          }
          return current;
        });
        return next;
      });
    },
    [],
  );

  const requestClose = useCallback(
    (tab: TerminalTab) => {
      if (tab.state === "closed") {
        removeTab(tab.id);
        return;
      }
      setClosingTab(tab);
    },
    [removeTab],
  );

  const handleGracefulClose = useCallback(() => {
    if (!closingTab) return;
    const tabId = closingTab.id;
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, state: "closing" as const } : t)),
    );
    setTimeout(() => removeTab(tabId), 500);
    setClosingTab(null);
  }, [closingTab, removeTab]);

  const handleHardKill = useCallback(() => {
    if (!closingTab) return;
    removeTab(closingTab.id);
    setClosingTab(null);
  }, [closingTab, removeTab]);

  return (
    <>
      {/* Terminal tab bar */}
      <div className="flex shrink-0 items-center gap-0.5 border-b bg-muted/30 px-2 pt-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            className={cn(
              "group/tab flex cursor-pointer items-center gap-1.5 rounded-t-md px-3 py-1.5 text-xs font-medium transition-colors",
              activeTerminal === tab.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setActiveTerminal(tab.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setActiveTerminal(tab.id); }}
          >
            <TerminalIcon className="size-3" />
            <span>{tab.label}</span>
            {tab.state === "closing" && (
              <LoaderCircleIcon className="size-3 animate-spin text-yellow-500" />
            )}
            <button
              type="button"
              className="ml-1 flex size-4 items-center justify-center rounded-sm opacity-0 transition-opacity hover:bg-muted group-hover/tab:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                requestClose(tab);
              }}
              title="Close terminal"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="ml-1 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={addTab}
          title="New terminal"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>

      {/* Terminal content */}
      <div className="min-h-0 flex-1">
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            tab={tab}
            isActive={activeTerminal === tab.id}
            instanceName={instanceName}
          />
        ))}
        {tabs.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <button
              type="button"
              className="flex items-center gap-2 rounded-md border px-4 py-2 transition-colors hover:bg-muted"
              onClick={addTab}
            >
              <PlusIcon className="size-4" />
              Open a terminal
            </button>
          </div>
        )}
      </div>

      {/* Close confirmation dialog */}
      <AlertDialog open={!!closingTab} onOpenChange={(open) => !open && setClosingTab(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close terminal?</AlertDialogTitle>
            <AlertDialogDescription>
              {closingTab?.label ?? "This terminal"} has a running process. How would you like to
              close it?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleGracefulClose}>
              Close gracefully
            </AlertDialogAction>
            <AlertDialogAction variant="destructive" onClick={handleHardKill}>
              <SkullIcon className="size-4" />
              Force kill
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Individual terminal pane — owns its xterm ref and handles input directly
// ---------------------------------------------------------------------------

function TerminalPane({
  tab,
  isActive,
  instanceName,
}: {
  tab: TerminalTab;
  isActive: boolean;
  instanceName: string;
}) {
  const xtermRef = useRef<XtermTerminalHandle>(null);
  const wroteWelcome = useRef(false);
  const lineBuffer = useRef("");
  const isExecuting = useRef(false);

  const executeCommand = useCallback(
    async (command: string) => {
      const handle = xtermRef.current;
      if (!handle || !command.trim()) {
        handle?.write("\r\n$ ");
        return;
      }

      isExecuting.current = true;
      handle.write("\r\n");
      try {
        const result = await execOnRuntime(instanceName, command);
        if (result.output) {
          // Write output, converting \n to \r\n for xterm
          handle.write(result.output.replace(/\n/g, "\r\n"));
          // Ensure output ends with newline
          if (!result.output.endsWith("\n")) {
            handle.write("\r\n");
          }
        }
        if (result.exitCode !== 0) {
          handle.write(`\x1b[31mexit code: ${result.exitCode}\x1b[0m\r\n`);
        }
      } catch {
        handle.write("\x1b[31mFailed to execute command\x1b[0m\r\n");
      }
      isExecuting.current = false;
      handle.write("$ ");
    },
    [instanceName],
  );

  const handleInput = useCallback(
    (data: string) => {
      const handle = xtermRef.current;
      if (!handle || isExecuting.current) return;

      for (const char of data) {
        switch (char) {
          case "\r": { // Enter
            const cmd = lineBuffer.current;
            lineBuffer.current = "";
            void executeCommand(cmd);
            break;
          }
          case "\x7f": // Backspace
            if (lineBuffer.current.length > 0) {
              lineBuffer.current = lineBuffer.current.slice(0, -1);
              handle.write("\b \b");
            }
            break;
          case "\x03": // Ctrl+C
            lineBuffer.current = "";
            handle.write("^C\r\n$ ");
            break;
          default:
            if (char >= " " || char === "\t") {
              lineBuffer.current += char;
              handle.write(char);
            }
            break;
        }
      }
    },
    [executeCommand],
  );

  // Write welcome message once terminal is mounted
  useEffect(() => {
    if (wroteWelcome.current) return;
    const timer = setTimeout(() => {
      const handle = xtermRef.current;
      if (!handle) return;
      wroteWelcome.current = true;

      handle.write(`\x1b[1;32mConnected to runtime ${instanceName}\x1b[0m\r\n`);
      handle.write(`\x1b[90mType commands to execute on the runtime.\x1b[0m\r\n\r\n`);
      handle.write("$ ");
    }, 50);
    return () => clearTimeout(timer);
  }, [instanceName]);

  // Re-fit when becoming active (tab switch)
  useEffect(() => {
    if (isActive) {
      requestAnimationFrame(() => xtermRef.current?.fit());
    }
  }, [isActive]);

  return (
    <div className={cn("h-full", isActive ? "block" : "hidden")}>
      <XtermTerminal
        ref={xtermRef}
        onInput={handleInput}
        className="h-full"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Traces tab — shows traces from ALL sessions on this runtime instance
// ---------------------------------------------------------------------------

function TracesTab({ instance }: { instance: RuntimeInstance }) {
  const { data: sessions } = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: 10_000,
  });

  const runtimeSessions = useMemo(() => {
    if (!sessions) return [];
    return sessions.filter((s) => s.runtime === instance.name);
  }, [sessions, instance.name]);

  if (!sessions) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (runtimeSessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        <div className="space-y-2 text-center">
          <ActivityIcon className="mx-auto size-8 text-muted-foreground/50" />
          <p>No active sessions on this runtime.</p>
          <p className="text-xs">Start a session to see traces here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {runtimeSessions.map((session) => (
        <div key={session.id} className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="shrink-0">
              {session.agentName}
            </Badge>
            <code className="truncate text-xs text-muted-foreground">
              {session.id.slice(0, 12)}...
            </code>
            <Badge
              variant="outline"
              className={cn(
                "ml-auto shrink-0",
                session.status === "active"
                  ? "text-green-700 dark:text-green-400"
                  : "text-muted-foreground",
              )}
            >
              {session.status}
            </Badge>
          </div>
          {session.logs.length === 0 ? (
            <p className="pl-2 text-xs text-muted-foreground">No trace entries yet.</p>
          ) : (
            <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
              {session.logs.map((log: { timestamp: string; type: string; data: Record<string, unknown> }, index: number) => (
                <Fragment key={index}>
                  {index > 0 && <Separator className="my-1" />}
                  <div className="flex items-start gap-2 text-xs">
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <Badge variant={getTraceVariant(log.type)} className="shrink-0 text-[10px]">
                      {log.type}
                    </Badge>
                    <pre className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                      {JSON.stringify(log.data, null, 2)}
                    </pre>
                  </div>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function EmptyPreview({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-[10rem] items-center justify-center p-6 text-sm text-muted-foreground">
      {message}
    </div>
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

function buildTree(entries: Array<{ path: string; type: string }>): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "directory", children: [] };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let current = root;

    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      let child = current.children.find((c) => c.path === path);

      if (!child) {
        child = {
          name: segment,
          path,
          type: index === segments.length - 1 ? (entry.type as TreeNode["type"]) : "directory",
          children: [],
        };
        current.children.push(child);
      }

      if (index === segments.length - 1) {
        child.type = entry.type as TreeNode["type"];
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
  for (const node of nodes) {
    if (node.children.length > 0) sortTree(node.children);
  }
}

function getInitialExpandedPaths(nodes: TreeNode[]) {
  return new Set(nodes.filter((n) => n.type === "directory").map((n) => n.path));
}

function getParentPaths(path: string) {
  const segments = path.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    parents.push(segments.slice(0, i + 1).join("/"));
  }
  return parents;
}

function getTraceVariant(type: string): "default" | "secondary" | "destructive" | "outline" {
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
    case "killed":
      return "destructive";
    default:
      return "outline";
  }
}
