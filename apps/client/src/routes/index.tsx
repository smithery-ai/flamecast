import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  useRuntimes,
  useAgentTemplates,
  useCreateSession,
  useSessions,
  useStartRuntime,
  useRuntimeFileSystem,
} from "@flamecast/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DirectoryPicker } from "@/components/directory-picker";
import { GitWorktreeMenu, useActiveBranch } from "@/components/git-worktree-picker";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronDownIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
  PlusIcon,
  SendIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useMemo, useState } from "react";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();
  const { data: runtimes, isLoading: runtimesLoading } = useRuntimes();
  const { data: templates, isLoading: templatesLoading } = useAgentTemplates();
  const { data: sessions } = useSessions();

  // --- Runtime type selection (default: first) ---
  const defaultRuntime = runtimes?.[0]?.typeName ?? "";
  const [selectedRuntime, setSelectedRuntime] = useState<string>("");
  const activeRuntime = selectedRuntime || defaultRuntime;
  const runtimeInfo = runtimes?.find((rt) => rt.typeName === activeRuntime);
  const isMultiInstance = runtimeInfo ? !runtimeInfo.onlyOne : false;

  // --- Runtime instance selection (default: first running) ---
  const [selectedInstanceName, setSelectedInstanceName] = useState<string>("");
  const runningInstances = runtimeInfo?.instances.filter((i) => i.status === "running") ?? [];
  const stoppedInstances =
    runtimeInfo?.instances.filter((i) => i.status === "stopped" || i.status === "paused") ?? [];
  const activeInstance = isMultiInstance
    ? (runtimeInfo?.instances.find(
        (i) => i.name === selectedInstanceName && i.status === "running",
      ) ?? runningInstances[0])
    : undefined;
  const needsRunningInstance = isMultiInstance && runningInstances.length === 0;

  // --- Agent selection (default: first) ---
  const matchingTemplates = templates?.filter((t) => t.runtime.provider === activeRuntime) ?? [];
  const defaultTemplate = matchingTemplates[0] ?? templates?.[0];
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const activeTemplate = selectedTemplateId
    ? (templates?.find((t) => t.id === selectedTemplateId) ?? defaultTemplate)
    : defaultTemplate;

  // --- Session selection (default: first active) ---
  const matchingSessions = useMemo(() => {
    if (!sessions || !activeTemplate) return [];
    return sessions.filter((s) => {
      if (s.agentName !== activeTemplate.name) return false;
      if (s.status !== "active") return false;
      if (!isMultiInstance) return true;
      if (activeInstance && s.runtime) return s.runtime === activeInstance.name;
      return true;
    });
  }, [sessions, activeTemplate, isMultiInstance, activeInstance]);

  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const activeSession = selectedSessionId
    ? (matchingSessions.find((s) => s.id === selectedSessionId) ?? matchingSessions[0])
    : matchingSessions[0];

  // --- Working directory ---
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);

  // Resolve an instance name for the directory picker
  const pickerInstanceName =
    activeInstance?.name ??
    runtimeInfo?.instances.find((i) => i.status === "running")?.name ??
    activeRuntime;

  // --- Git detection for selected directory ---
  const { data: cwdFsData } = useRuntimeFileSystem(pickerInstanceName, {
    enabled: !!cwd,
    path: cwd,
  });
  const gitPath = cwdFsData?.gitPath;
  const activeBranch = useActiveBranch(pickerInstanceName, gitPath, cwd ?? "");

  // --- Mutations ---
  const [prompt, setPrompt] = useState("");

  const startRuntimeMutation = useStartRuntime({
    onError: (err) => toast.error("Failed to start runtime", { description: String(err.message) }),
  });

  const createMutation = useCreateSession({
    onSuccess: (session) => {
      setSelectedSessionId(session.id);
    },
    onError: (err) => toast.error("Failed to create session", { description: String(err.message) }),
  });

  const isReady = !runtimesLoading && !templatesLoading && runtimes && runtimes.length > 0;

  const handleStartInstance = (instanceName?: string) => {
    startRuntimeMutation.mutate({ typeName: activeRuntime, name: instanceName });
  };

  const handleCreateSession = () => {
    if (!activeTemplate) return;
    createMutation.mutate({
      agentTemplateId: activeTemplate.id,
      runtimeInstance: activeInstance?.name,
      cwd,
    });
  };

  const handleSend = () => {
    if (!prompt.trim() || !activeSession) return;
    // Navigate to the runtime instance containing the session
    const rt = runtimes?.find(
      (r) =>
        r.typeName === activeSession.runtime ||
        r.instances.some((i) => i.name === activeSession.runtime),
    );
    const typeName = rt?.typeName ?? activeSession.runtime ?? activeRuntime;
    const instanceName = activeSession.runtime ?? typeName;
    void navigate({
      to: "/runtimes/$typeName/$instanceName",
      params: { typeName, instanceName },
    });
  };

  const hasActiveSession = !!activeSession;
  const canSend = prompt.trim() && hasActiveSession && isReady;
  const isBusy = startRuntimeMutation.isPending || createMutation.isPending;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8 px-1">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">Flamecast</h1>
        <p className="mt-2 text-sm text-muted-foreground">What would you like to work on?</p>
      </div>

      <div className="flex w-full flex-col gap-3">
        <div className="flex gap-2">
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canSend && handleSend()}
            placeholder={
              !isReady
                ? "Loading…"
                : needsRunningInstance
                  ? "Start a runtime instance first…"
                  : !hasActiveSession
                    ? "Create a session first…"
                    : "Send a prompt to the agent..."
            }
            disabled={!isReady || !hasActiveSession}
            className="flex-1"
          />
          <Button onClick={handleSend} disabled={!canSend}>
            <SendIcon data-icon="inline-start" />
            Send
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Runtime type dropdown */}
          {runtimesLoading ? (
            <Skeleton className="h-6 w-28" />
          ) : runtimes && runtimes.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                  <span className="text-muted-foreground">Runtime:</span>
                  {activeRuntime}
                  <ChevronDownIcon className="size-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {runtimes.map((rt) => (
                  <DropdownMenuItem
                    key={rt.typeName}
                    onSelect={() => {
                      setSelectedRuntime(rt.typeName);
                      setSelectedInstanceName("");
                      setSelectedTemplateId("");
                      setSelectedSessionId("");
                    }}
                  >
                    {rt.typeName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {/* Runtime instance dropdown (multi-instance only) */}
          {isReady && isMultiInstance ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                  {startRuntimeMutation.isPending ? (
                    <LoaderCircleIcon className="size-3 animate-spin" />
                  ) : null}
                  <span className="text-muted-foreground">Instance:</span>
                  {startRuntimeMutation.isPending ? "Starting…" : (activeInstance?.name ?? "None")}
                  <ChevronDownIcon className="size-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {runningInstances.map((inst) => (
                  <DropdownMenuItem
                    key={inst.name}
                    onSelect={() => {
                      setSelectedInstanceName(inst.name);
                      setSelectedSessionId("");
                    }}
                  >
                    {inst.name}
                  </DropdownMenuItem>
                ))}
                {stoppedInstances.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    {stoppedInstances.map((inst) => (
                      <DropdownMenuItem
                        key={inst.name}
                        onSelect={() => handleStartInstance(inst.name)}
                      >
                        {inst.name}
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {inst.status}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => handleStartInstance()}
                  disabled={startRuntimeMutation.isPending}
                >
                  <PlusIcon className="size-3.5" />
                  Create new
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {/* Agent dropdown */}
          {runtimesLoading || templatesLoading ? (
            <Skeleton className="h-6 w-24" />
          ) : isReady ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                  <span className="text-muted-foreground">Agent:</span>
                  {activeTemplate?.name ?? "None"}
                  <ChevronDownIcon className="size-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {matchingTemplates.length > 0
                  ? matchingTemplates.map((t) => (
                      <DropdownMenuItem
                        key={t.id}
                        onSelect={() => {
                          setSelectedTemplateId(t.id);
                          setSelectedSessionId("");
                        }}
                      >
                        {t.name}
                      </DropdownMenuItem>
                    ))
                  : templates && templates.length > 0
                    ? templates.map((t) => (
                        <DropdownMenuItem
                          key={t.id}
                          onSelect={() => {
                            setSelectedTemplateId(t.id);
                            setSelectedSessionId("");
                          }}
                        >
                          {t.name}
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            {t.runtime.provider}
                          </span>
                        </DropdownMenuItem>
                      ))
                    : null}
                {(!templates || templates.length === 0) && (
                  <DropdownMenuItem disabled>No agents registered</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/agents">
                    <PlusIcon className="size-3.5" />
                    Create new
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {/* Session dropdown */}
          {isReady && !needsRunningInstance ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                  {createMutation.isPending ? (
                    <LoaderCircleIcon className="size-3 animate-spin" />
                  ) : null}
                  <span className="text-muted-foreground">Session:</span>
                  {createMutation.isPending
                    ? "Creating…"
                    : activeSession
                      ? `...${activeSession.id.slice(-8)}`
                      : "None"}
                  <ChevronDownIcon className="size-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {matchingSessions.map((s) => (
                  <DropdownMenuItem key={s.id} onSelect={() => setSelectedSessionId(s.id)}>
                    ...{s.id.slice(-8)}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={handleCreateSession}
                  disabled={isBusy || !activeTemplate}
                >
                  <PlusIcon className="size-3.5" />
                  Create new
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {/* Directory picker */}
          {isReady ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => setDirPickerOpen(true)}
              >
                <FolderOpenIcon className="size-3" />
                <span className="text-muted-foreground">Dir:</span>
                <span className="max-w-32 truncate">{cwd ?? "default"}</span>
              </Button>
              <DirectoryPicker
                instanceName={pickerInstanceName}
                open={dirPickerOpen}
                onOpenChange={setDirPickerOpen}
                onSelect={(path) => setCwd(path)}
                initialPath={cwd}
              />
            </>
          ) : null}

          {/* Git branch dropdown */}
          {isReady && gitPath && activeBranch ? (
            <GitWorktreeMenu
              instanceName={pickerInstanceName}
              gitPath={gitPath}
              activeBranch={activeBranch}
              onSelect={(path) => setCwd(path)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
