import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  useRuntimes,
  useAgentTemplates,
  useCreateSession,
  useSessions,
  useStartRuntime,
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircleIcon,
  ChevronDownIcon,
  LoaderCircleIcon,
  PlusIcon,
  SendIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();
  const { data: runtimes, isLoading: runtimesLoading } = useRuntimes();
  const { data: templates, isLoading: templatesLoading } = useAgentTemplates();
  const { data: sessions } = useSessions();

  // --- Runtime selection ---
  const defaultRuntime = runtimes?.[0]?.typeName ?? "";
  const [selectedRuntime, setSelectedRuntime] = useState<string>("");
  const activeRuntime = selectedRuntime || defaultRuntime;
  const runtimeInfo = runtimes?.find((rt) => rt.typeName === activeRuntime);
  const runningInstance = runtimeInfo?.instances.find((i) => i.status === "running");
  const needsRunningInstance = runtimeInfo && !runtimeInfo.onlyOne && !runningInstance;

  // --- Agent selection ---
  const matchingTemplates = templates?.filter((t) => t.runtime.provider === activeRuntime) ?? [];
  const defaultTemplate = matchingTemplates[0] ?? templates?.[0];
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const activeTemplate = selectedTemplateId
    ? (templates?.find((t) => t.id === selectedTemplateId) ?? defaultTemplate)
    : defaultTemplate;

  // --- Session matching + selection ---
  const matchingSessions = useMemo(() => {
    if (!sessions || !activeTemplate) return [];
    return sessions.filter((s) => {
      if (s.agentName !== activeTemplate.name) return false;
      if (s.status !== "active") return false;
      if (runtimeInfo?.onlyOne) return true;
      if (!s.runtime) return true;
      return runtimeInfo?.instances.some((i) => i.name === s.runtime);
    });
  }, [sessions, activeTemplate, runtimeInfo]);

  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const activeSession = selectedSessionId
    ? (matchingSessions.find((s) => s.id === selectedSessionId) ?? matchingSessions[0])
    : matchingSessions[0];

  // --- Mutations ---
  const [prompt, setPrompt] = useState("");

  const startRuntimeMutation = useStartRuntime({
    onError: (err) => toast.error("Failed to start runtime", { description: String(err.message) }),
  });

  const createMutation = useCreateSession({
    onError: (err) => toast.error("Failed to create session", { description: String(err.message) }),
  });

  const isReady = !runtimesLoading && !templatesLoading && runtimes && runtimes.length > 0;

  // Auto-start a runtime instance for multi-instance runtimes with no running instance
  const autoStartAttempted = useRef<string | null>(null);
  useEffect(() => {
    if (!isReady || !needsRunningInstance || startRuntimeMutation.isPending) return;
    if (autoStartAttempted.current === activeRuntime) return;
    autoStartAttempted.current = activeRuntime;
    startRuntimeMutation.mutate({ typeName: activeRuntime });
  }, [isReady, needsRunningInstance, activeRuntime, startRuntimeMutation]);

  // Auto-create a session when a running instance is available but no matching session exists
  const autoCreateAttempted = useRef<string | null>(null);
  useEffect(() => {
    if (!isReady || !activeTemplate || createMutation.isPending) return;
    if (needsRunningInstance) return;
    if (matchingSessions.length > 0) return;

    const key = `${activeTemplate.id}:${activeRuntime}`;
    if (autoCreateAttempted.current === key) return;
    autoCreateAttempted.current = key;

    createMutation.mutate({
      agentTemplateId: activeTemplate.id,
      runtimeInstance: runningInstance?.name,
    });
  }, [
    isReady,
    activeTemplate,
    activeRuntime,
    needsRunningInstance,
    matchingSessions.length,
    runningInstance,
    createMutation,
  ]);

  const handleSend = () => {
    if (!prompt.trim() || !activeSession) return;
    void navigate({
      to: "/sessions/$id",
      params: { id: activeSession.id },
      search: { prompt: prompt.trim() },
    });
  };

  const canSend = prompt.trim() && activeSession && isReady;
  const isInitializing = startRuntimeMutation.isPending || createMutation.isPending;

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
            placeholder="Send a prompt to the agent..."
            disabled={isInitializing || !isReady}
            className="flex-1"
          />
          <Button onClick={handleSend} disabled={!canSend}>
            {isInitializing ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SendIcon data-icon="inline-start" />
            )}
            {isInitializing ? "Initializing…" : "Send"}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Runtime dropdown */}
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
            matchingSessions.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                    <span className="text-muted-foreground">Session:</span>
                    {activeSession ? `...${activeSession.id.slice(-8)}` : "None"}
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
                  <DropdownMenuItem asChild>
                    <Link
                      to="/sessions/$id"
                      params={{ id: activeSession?.id ?? matchingSessions[0].id }}
                    >
                      Open session
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : createMutation.isPending ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <LoaderCircleIcon className="size-3 animate-spin" />
                Creating session…
              </span>
            ) : null
          ) : needsRunningInstance ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {startRuntimeMutation.isPending ? (
                <>
                  <LoaderCircleIcon className="size-3 animate-spin" />
                  Starting {activeRuntime} instance…
                </>
              ) : (
                <>
                  <AlertCircleIcon className="size-3" />
                  No running {activeRuntime} instance
                </>
              )}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
