import { createFileRoute } from "@tanstack/react-router";
import {
  useRuntimes,
  useRuntimeFileSystem,
  useStartRuntimeWithOptimisticUpdate,
  useTerminal,
  useFlamecastClient,
  useTerminateSession,
  useSessions,
} from "@flamecast/ui";
import { RuntimeFileTree } from "@/components/runtime-file-tree";
import { RuntimeNewTab } from "@/components/runtime-new-tab";
import { RuntimeSessionTab } from "@/components/runtime-session-tab";
import { RuntimeFileTab } from "@/components/runtime-file-tab";
import { TerminalPanel } from "@/components/terminal-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import {
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
  XIcon,
  FileCode2Icon,
  MessageSquareIcon,
  LayoutGridIcon,
  GripHorizontalIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { cn } from "@/lib/utils";
import type { RuntimeInfo, RuntimeInstance } from "@flamecast/protocol/runtime";

export const Route = createFileRoute("/runtimes/$typeName/$instanceName")({
  component: RuntimeInstancePage,
});

// ─── Tab Types ───────────────────────────────────────────────────────────────

type Tab =
  | { id: string; type: "new-tab" }
  | { id: string; type: "session"; sessionId: string; label: string }
  | { id: string; type: "file"; filePath: string; label: string };

let nextTabId = 1;
function makeTabId() {
  return `tab-${nextTabId++}`;
}

function fileNameFromPath(path: string) {
  return path.split("/").pop() ?? path;
}

// ─── Page Component ──────────────────────────────────────────────────────────

function RuntimeInstancePage() {
  const { typeName, instanceName } = Route.useParams();
  const { data: runtimes } = useRuntimes();

  const runtimeInfo = runtimes?.find((rt) => rt.typeName === typeName);
  const instance =
    runtimeInfo?.instances.find((i) => i.name === instanceName) ??
    (runtimeInfo?.onlyOne
      ? {
          name: instanceName,
          typeName,
          status: "stopped" as const,
        }
      : undefined);

  if (!runtimeInfo || !instance) {
    return (
      <div className="mx-auto w-full max-w-3xl px-1">
        <h1 className="text-2xl font-bold tracking-tight">Instance not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          No runtime instance "{instanceName}" found in {typeName}.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <RuntimeDetailPanel runtimeInfo={runtimeInfo} instance={instance} />
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

function RuntimeDetailPanel({
  runtimeInfo,
  instance,
}: {
  runtimeInfo: RuntimeInfo;
  instance: RuntimeInstance;
}) {
  const client = useFlamecastClient();
  const [showAllFiles, setShowAllFiles] = useState(false);
  const isRunning = instance.status === "running";

  // Tab state — hydrate from active sessions on mount
  const { data: sessions } = useSessions();
  const initialTab = useRef<Tab>({ id: makeTabId(), type: "new-tab" });
  const [tabs, setTabs] = useState<Tab[]>([initialTab.current]);
  const [activeTabId, setActiveTabId] = useState(initialTab.current.id);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current || !sessions) return;
    hydratedRef.current = true;
    const instanceSessions = sessions.filter(
      (s) => s.status === "active" && s.runtime === instance.name,
    );
    if (instanceSessions.length === 0) return;
    const sessionTabs: Tab[] = instanceSessions.map((s) => ({
      id: makeTabId(),
      type: "session" as const,
      sessionId: s.id,
      label: s.agentName,
    }));
    setTabs(sessionTabs);
    setActiveTabId(sessionTabs[0].id);
  }, [sessions, instance.name]);

  const runtimeFsQuery = useRuntimeFileSystem(instance.name, {
    enabled: isRunning,
    showAllFiles,
  });

  const { terminals, sendInput, resize, onData, createTerminal, killTerminal } = useTerminal(
    isRunning ? instance.websocketUrl : undefined,
  );

  const terminateMutation = useTerminateSession();

  const startMutation = useStartRuntimeWithOptimisticUpdate(runtimeInfo, {
    instanceName: instance.name,
    onError: (err) => toast.error("Failed to start runtime", { description: String(err.message) }),
  });

  // ─── Tab operations ──────────────────────────────────────────────────────

  const addNewTab = useCallback(() => {
    const tab: Tab = { id: makeTabId(), type: "new-tab" };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  const openSessionTab = useCallback(
    (sessionId: string, agentName: string) => {
      const existing = tabs.find((t) => t.type === "session" && t.sessionId === sessionId);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const tab: Tab = {
        id: makeTabId(),
        type: "session",
        sessionId,
        label: agentName,
      };
      // Replace the current active new-tab, otherwise append
      const activeTab = tabs.find((t) => t.id === activeTabId);
      if (activeTab?.type === "new-tab") {
        setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? tab : t)));
      } else {
        setTabs((prev) => [...prev, tab]);
      }
      setActiveTabId(tab.id);
    },
    [tabs, activeTabId],
  );

  const openFileTab = useCallback(
    (filePath: string) => {
      const existing = tabs.find((t) => t.type === "file" && t.filePath === filePath);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const tab: Tab = {
        id: makeTabId(),
        type: "file",
        filePath,
        label: fileNameFromPath(filePath),
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
    },
    [tabs],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;

      const closedTab = tabs[idx];
      if (closedTab.type === "session") {
        terminateMutation.mutate(closedTab.sessionId);
      }

      const next = tabs.filter((t) => t.id !== tabId);

      if (next.length === 0) {
        const newTab: Tab = { id: makeTabId(), type: "new-tab" };
        setTabs([newTab]);
        setActiveTabId(newTab.id);
        return;
      }

      setTabs(next);
      if (activeTabId === tabId) {
        const newIdx = Math.min(idx, next.length - 1);
        setActiveTabId(next[newIdx].id);
      }
    },
    [tabs, activeTabId, terminateMutation],
  );

  const loadPreview = useCallback(
    (path: string) => client.fetchRuntimeFilePreview(instance.name, path),
    [client, instance.name],
  );

  // ─── Not running state ───────────────────────────────────────────────────

  if (!isRunning) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6">
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">
              {startMutation.isPending ? "Starting runtime..." : "Runtime not running"}
            </CardTitle>
            <CardDescription>
              {startMutation.isPending
                ? "Waiting for the runtime instance to come up."
                : `${instance.name} is currently ${instance.status}. Start it to begin working.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
              {startMutation.isPending ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {startMutation.isPending ? "Starting..." : "Start runtime"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ─── Running state: full layout ──────────────────────────────────────────

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ResizablePanelGroup className="min-h-0 flex-1">
        {/* ── Left: Tabs area ── */}
        <ResizablePanel defaultSize={65} minSize={30}>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden h-full">
            {/* Tab bar */}
            <div className="flex shrink-0 items-center gap-0 border-b bg-muted/30 px-1">
              <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
                {tabs.map((tab) => (
                  <TabTrigger
                    key={tab.id}
                    tab={tab}
                    isActive={tab.id === activeTabId}
                    onClick={() => setActiveTabId(tab.id)}
                    onClose={() => closeTab(tab.id)}
                  />
                ))}
                <button
                  type="button"
                  className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ml-2"
                  onClick={addNewTab}
                  title="New tab"
                >
                  <PlusIcon className="size-3.5" />
                </button>
              </div>
            </div>

            {/* Tab content */}
            <div className="h-0 min-h-0 flex-1 flex flex-col overflow-hidden">
              {activeTab?.type === "new-tab" && (
                <RuntimeNewTab
                  runtimeTypeName={runtimeInfo.typeName}
                  instanceName={instance.name}
                  onSessionCreated={openSessionTab}
                />
              )}
              {activeTab?.type === "session" && (
                <RuntimeSessionTab sessionId={activeTab.sessionId} />
              )}
              {activeTab?.type === "file" && (
                <RuntimeFileTab filePath={activeTab.filePath} loadPreview={loadPreview} />
              )}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* ── Right: Filesystem (top) + Terminals (bottom) ── */}
        <ResizablePanel defaultSize={35} minSize={20}>
          <VerticalSplitPanel
            topContent={
              runtimeFsQuery.isLoading ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                  Loading filesystem...
                </div>
              ) : runtimeFsQuery.isError || !runtimeFsQuery.data ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
                  <p className="text-xs text-muted-foreground">Could not load filesystem</p>
                  <Button variant="outline" size="sm" onClick={() => void runtimeFsQuery.refetch()}>
                    Retry
                  </Button>
                </div>
              ) : (
                <RuntimeFileTree
                  workspaceRoot={runtimeFsQuery.data.root}
                  entries={runtimeFsQuery.data.entries}
                  showAllFiles={showAllFiles}
                  onShowAllFilesChange={setShowAllFiles}
                  onFileSelect={openFileTab}
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
    </div>
  );
}

// ─── Tab Trigger ─────────────────────────────────────────────────────────────

function TabTrigger({
  tab,
  isActive,
  onClick,
  onClose,
}: {
  tab: Tab;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const icon =
    tab.type === "new-tab" ? (
      <LayoutGridIcon className="size-3 shrink-0" />
    ) : tab.type === "session" ? (
      <MessageSquareIcon className="size-3 shrink-0" />
    ) : (
      <FileCode2Icon className="size-3 shrink-0" />
    );

  const label = tab.type === "new-tab" ? "New Tab" : tab.type === "session" ? tab.label : tab.label;

  return (
    <div
      className={cn(
        "group/tab flex w-36 shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-xs transition-colors cursor-pointer select-none flex justify-between",
        isActive
          ? "border-primary bg-background text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
      onClick={onClick}
      role="tab"
      aria-selected={isActive}
    >
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="max-w-32 truncate">{label}</span>
      </div>
      <button
        type="button"
        className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover/tab:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close tab"
      >
        <XIcon className="size-3" />
      </button>
    </div>
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
