import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  useRuntimes,
  useAgentTemplates,
  useCreateSession,
  useStartRuntime,
  useRuntimeFileSystem,
  useFlamecastClient,
} from "@flamecast/ui";
import { useDefaultAgentConfig } from "@/lib/default-agent-config-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DirectoryPicker } from "@/components/directory-picker";
import { GitWorktreeMenu, useActiveBranch } from "@/components/git-worktree-picker";
import { SlashCommandInput } from "@/components/slash-command-input";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDownIcon, FolderOpenIcon, LoaderCircleIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { useCallback, useState } from "react";
import { useEnqueueMessage } from "@flamecast/ui";
import flamecastMascots from "@/assets/flamecast_mascots.webp";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return <DeveloperHomePage />;
}

// ─── Developer Home Page (full controls) ──────────────────────────────────────

function DeveloperHomePage() {
  const navigate = useNavigate();
  const { config } = useDefaultAgentConfig();
  const { data: runtimes, isLoading: runtimesLoading } = useRuntimes();
  const { data: templates, isLoading: templatesLoading } = useAgentTemplates();

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

  // --- Agent selection (default: from settings config, fallback to first) ---
  const matchingTemplates = templates?.filter((t) => t.runtime.provider === activeRuntime) ?? [];
  const defaultTemplate = matchingTemplates[0] ?? templates?.[0];
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(config.agentTemplateId);
  const activeTemplate = selectedTemplateId
    ? (templates?.find((t) => t.id === selectedTemplateId) ?? defaultTemplate)
    : defaultTemplate;

  // --- Working directory (default: from settings config) ---
  const [cwd, setCwd] = useState<string | undefined>(config.defaultDirectory || undefined);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);

  // Resolve an instance name for the directory picker
  const pickerInstanceName =
    activeInstance?.name ??
    runtimeInfo?.instances.find((i) => i.status === "running")?.name ??
    activeRuntime;

  // --- Default root directory for the runtime ---
  const { data: defaultFsData } = useRuntimeFileSystem(pickerInstanceName);
  const defaultDir = defaultFsData?.root;

  // --- Git detection for selected directory ---
  const { data: cwdFsData } = useRuntimeFileSystem(pickerInstanceName, {
    enabled: !!cwd,
    path: cwd,
  });
  const gitPath = cwdFsData?.gitPath;
  const activeBranch = useActiveBranch(pickerInstanceName, gitPath, cwd ?? "");

  // --- Message queue ---
  const enqueueMutation = useEnqueueMessage({
    onSuccess: () => toast.success("Message queued"),
    onError: (err) => toast.error("Failed to queue message", { description: String(err.message) }),
  });

  // --- Mutations ---
  const client = useFlamecastClient();

  const startRuntimeMutation = useStartRuntime({
    onError: (err) => toast.error("Failed to start runtime", { description: String(err.message) }),
  });

  const createMutation = useCreateSession({
    onError: (err) => toast.error("Failed to create session", { description: String(err.message) }),
  });

  const isReady = !runtimesLoading && !templatesLoading && runtimes && runtimes.length > 0;

  // Fetch slash commands for the selected directory
  const fetchCommands = useCallback(
    () =>
      client.rpc.runtimes[":instanceName"].fs.commands
        .$get({
          param: { instanceName: pickerInstanceName },
          query: { path: cwd ?? defaultDir },
        })
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => (Array.isArray(data) ? data : [])),
    [client, pickerInstanceName, cwd, defaultDir],
  );

  const handleStartInstance = (instanceName?: string) => {
    startRuntimeMutation.mutate({ typeName: activeRuntime, name: instanceName });
  };

  const handleSend = (text: string) => {
    if (!text.trim() || !isReady || !activeTemplate) return;

    const templateName = activeTemplate.name;
    const templateId = activeTemplate.id;
    const runtimeName = activeRuntime;
    const instanceName = activeInstance?.name ?? activeRuntime;
    const dir = cwd ?? null;
    createMutation.mutate(
      {
        agentTemplateId: templateId,
        runtimeInstance: activeInstance?.name,
        cwd,
        agentName: templateName,
      },
      {
        onSuccess: (session) => {
          enqueueMutation.mutate({
            text,
            runtime: runtimeName,
            agent: templateName,
            agentTemplateId: templateId,
            directory: dir,
            sessionId: session.id,
          });
          void navigate({
            to: "/runtimes/$typeName/$instanceName",
            params: { typeName: runtimeName, instanceName },
            search: { sessionId: session.id },
          });
        },
      },
    );
  };

  const isBusy = startRuntimeMutation.isPending || createMutation.isPending;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8 px-1">
      <div className="text-center">
        <img
          src={flamecastMascots}
          alt="Flamecast mascots"
          className="mx-auto mb-6 w-full max-w-md"
        />
        <h1 className="text-3xl font-bold tracking-tight">Flamecast</h1>
        <p className="mt-2 text-sm text-muted-foreground">What would you like to work on?</p>
      </div>

      <div className="flex w-full flex-col gap-3">
        <SlashCommandInput
          fetchCommands={fetchCommands}
          onSend={handleSend}
          disabled={!isReady || needsRunningInstance || isBusy}
          placeholder={
            createMutation.isPending
              ? "Creating session…"
              : !isReady
                ? "Loading…"
                : needsRunningInstance
                  ? "Start a runtime instance first…"
                  : "Send a prompt or type / for commands…"
          }
        />
        {createMutation.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            <span>Creating session and sending message…</span>
          </div>
        )}

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
