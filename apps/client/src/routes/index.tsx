import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useRuntimes, useAgentTemplates, useCreateSession, useSessions } from "@flamecast/ui";
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
  ChevronDownIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
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

  const defaultRuntime = runtimes?.[0]?.typeName ?? "";
  const [selectedRuntime, setSelectedRuntime] = useState<string>("");
  const activeRuntime = selectedRuntime || defaultRuntime;

  // Filter templates by selected runtime, then pick first as default
  const matchingTemplates = templates?.filter((t) => t.runtime.provider === activeRuntime) ?? [];
  const defaultTemplate = matchingTemplates[0] ?? templates?.[0];

  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const activeTemplate = selectedTemplateId
    ? (templates?.find((t) => t.id === selectedTemplateId) ?? defaultTemplate)
    : defaultTemplate;

  // Find active sessions matching the selected agent + runtime combo
  const matchingSessions = useMemo(() => {
    if (!sessions || !activeTemplate) return [];
    const runtimeInfo = runtimes?.find((rt) => rt.typeName === activeRuntime);
    return sessions.filter((s) => {
      if (s.agentName !== activeTemplate.name) return false;
      if (s.status !== "active") return false;
      // For onlyOne runtimes, runtime field may be undefined — match all
      if (runtimeInfo?.onlyOne) return true;
      // For multi-instance, match by runtime instance name
      if (!s.runtime) return true;
      return runtimeInfo?.instances.some((i) => i.name === s.runtime);
    });
  }, [sessions, activeTemplate, runtimes, activeRuntime]);

  const [prompt, setPrompt] = useState("");

  const createMutation = useCreateSession({
    onError: (err) => toast.error("Failed to create session", { description: String(err.message) }),
  });

  const isReady = !runtimesLoading && !templatesLoading && runtimes && runtimes.length > 0;

  // Auto-create a session when no matching session exists for the selected combo
  const autoCreateAttempted = useRef<string | null>(null);
  useEffect(() => {
    if (!isReady || !activeTemplate || createMutation.isPending) return;
    if (matchingSessions.length > 0) return;

    // Only attempt once per agent+runtime combo
    const key = `${activeTemplate.id}:${activeRuntime}`;
    if (autoCreateAttempted.current === key) return;
    autoCreateAttempted.current = key;

    const runtimeInfo = runtimes?.find((rt) => rt.typeName === activeRuntime);
    const runtimeInstance =
      runtimeInfo && !runtimeInfo.onlyOne
        ? runtimeInfo.instances.find((i) => i.status === "running")?.name
        : undefined;

    createMutation.mutate({
      agentTemplateId: activeTemplate.id,
      runtimeInstance,
    });
  }, [isReady, activeTemplate, activeRuntime, matchingSessions.length, runtimes, createMutation]);

  const handleSend = () => {
    if (!prompt.trim() || !activeTemplate) return;

    const targetSession = matchingSessions[0];
    if (targetSession) {
      void navigate({
        to: "/sessions/$id",
        params: { id: targetSession.id },
        search: { prompt: prompt.trim() },
      });
    }
  };

  const canSend = prompt.trim() && activeTemplate && matchingSessions.length > 0 && isReady;

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
            disabled={createMutation.isPending || !isReady}
            className="flex-1"
          />
          <Button onClick={handleSend} disabled={!canSend}>
            {createMutation.isPending ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SendIcon data-icon="inline-start" />
            )}
            {createMutation.isPending ? "Initializing…" : "Send"}
          </Button>
        </div>

        <div className="flex items-center gap-3">
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
                    }}
                  >
                    {rt.typeName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

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
                      <DropdownMenuItem key={t.id} onSelect={() => setSelectedTemplateId(t.id)}>
                        {t.name}
                      </DropdownMenuItem>
                    ))
                  : templates && templates.length > 0
                    ? templates.map((t) => (
                        <DropdownMenuItem key={t.id} onSelect={() => setSelectedTemplateId(t.id)}>
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
        </div>

        {matchingSessions.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-1">
            <span className="text-xs text-muted-foreground">Active sessions</span>
            {matchingSessions.map((s) => (
              <Link
                key={s.id}
                to="/sessions/$id"
                params={{ id: s.id }}
                className="group flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
              >
                <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{s.agentName}</span>
                <code className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  ...{s.id.slice(-8)}
                </code>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
