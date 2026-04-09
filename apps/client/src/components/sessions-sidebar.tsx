import React from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  useRuntimes,
  useSessions,
  useStartRuntime,
  useStopRuntime,
  usePauseRuntime,
  useDeleteRuntime,
  useRuntimeFileSystem,
} from "@flamecast/ui";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GitBadges } from "@/components/git-badges";
import {
  CheckIcon,
  FolderIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SettingsIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useBackendUrl } from "@/lib/backend-url-context";
import { isDeveloperPreview } from "@/lib/developer-preview";
import type { RuntimeInfo } from "@flamecast/protocol/runtime";
import type { Session } from "@flamecast/protocol/session";

export function SessionsSidebar() {
  const { activeRuntimeTypeName, activeRuntimeInstanceName, activeSessionId } = useRouterState({
    select: (s) => {
      const runtimeMatch = s.matches.find(
        (m) =>
          m.routeId === "/runtimes/$typeName/$instanceName" || m.routeId === "/runtimes/$typeName",
      );
      const instanceMatch = s.matches.find(
        (m) => m.routeId === "/runtimes/$typeName/$instanceName",
      );
      const search = instanceMatch?.search;
      const sessionId =
        typeof search === "object" &&
        search !== null &&
        "sessionId" in search &&
        typeof search.sessionId === "string"
          ? search.sessionId
          : undefined;

      // Also detect previous session view route
      const sessionViewMatch = s.matches.find((m) => m.routeId === "/sessions/$sessionId");
      const viewingSessionId =
        sessionViewMatch?.params.sessionId as string | undefined;

      return {
        activeRuntimeTypeName: runtimeMatch?.params.typeName,
        activeRuntimeInstanceName: instanceMatch?.params.instanceName,
        activeSessionId: sessionId ?? viewingSessionId,
      };
    },
  });
  const { data: runtimes, isLoading: isRuntimesLoading } = useRuntimes();
  const { data: sessions, isLoading: isSessionsLoading } = useSessions();
  const activeSessions = sessions?.filter((s) => s.status === "active") ?? [];
  const previousSessions = sessions?.filter((s) => s.status === "killed") ?? [];

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <span className="text-base leading-none">🔥</span>
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Flamecast</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link to="/agents">
                    <TerminalIcon className="size-4" />
                    Agents
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {(isSessionsLoading || activeSessions.length > 0) && (
          <SidebarGroup>
            <SidebarGroupLabel>Sessions</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {isSessionsLoading ? (
                  <>
                    <SidebarMenuSkeleton />
                    <SidebarMenuSkeleton />
                  </>
                ) : (
                  activeSessions.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      runtimes={runtimes ?? []}
                      isActive={activeSessionId === session.id}
                    />
                  ))
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {previousSessions.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Previous Sessions</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {previousSessions.map((session) => (
                  <PreviousSessionItem
                    key={session.id}
                    session={session}
                    isActive={activeSessionId === session.id}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {isDeveloperPreview && (isRuntimesLoading || (runtimes && runtimes.length > 0)) && (
          <SidebarGroup>
            <SidebarGroupLabel>Runtimes</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {isRuntimesLoading ? (
                  <>
                    <SidebarMenuSkeleton />
                    <SidebarMenuSkeleton />
                  </>
                ) : (
                  runtimes?.map((rt) => (
                    <RuntimeTypeItem
                      key={rt.typeName}
                      runtime={rt}
                      activeTypeName={activeRuntimeTypeName}
                      activeInstanceName={activeRuntimeInstanceName}
                    />
                  ))
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <BackendUrlSetting />
      </SidebarFooter>
    </Sidebar>
  );
}

// ─── Session Item ─────────────────────────────────────────────────────────────

/** Resolve a session's runtime instance to its type name for navigation. */
function resolveRuntimeTypeName(
  session: Session,
  runtimes: RuntimeInfo[],
): { typeName: string; instanceName: string } | null {
  const instanceName = session.runtime;
  if (!instanceName) return null;
  for (const rt of runtimes) {
    if (rt.onlyOne && rt.typeName === instanceName) {
      return { typeName: rt.typeName, instanceName };
    }
    if (rt.instances.some((i) => i.name === instanceName)) {
      return { typeName: rt.typeName, instanceName };
    }
  }
  return null;
}

function SessionItem({
  session,
  runtimes,
  isActive,
}: {
  session: Session;
  runtimes: RuntimeInfo[];
  isActive: boolean;
}) {
  const navigate = useNavigate();
  const target = resolveRuntimeTypeName(session, runtimes);
  const isPending = !session.spawn.command;

  const title = session.title || session.agentName;
  const cwd = session.cwd;
  const cwdShort = cwd ? shortenPath(cwd) : undefined;

  const handleClick = () => {
    if (!target) return;
    void navigate({
      to: "/runtimes/$typeName/$instanceName",
      params: target,
      search: { sessionId: session.id },
    });
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="h-auto items-start py-1.5"
        isActive={isActive}
        onClick={handleClick}
        disabled={!target && !isPending}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            {isPending && (
              <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-muted-foreground" />
            )}
            <span className="truncate text-xs font-medium leading-tight">{title}</span>
          </div>
          <div className="flex min-w-0 items-center gap-1 text-[10px] leading-tight text-muted-foreground">
            {target ? (
              <SessionGitOrCwd instanceName={target.instanceName} cwd={cwd} cwdShort={cwdShort} />
            ) : cwdShort ? (
              <span className="flex min-w-0 items-center gap-1">
                <FolderIcon className="size-2.5 shrink-0" />
                <span className="truncate">{cwdShort}</span>
              </span>
            ) : null}
          </div>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function PreviousSessionItem({
  session,
  isActive,
}: {
  session: Session;
  isActive: boolean;
}) {
  const navigate = useNavigate();

  const title = session.title || "(empty session)";
  const endedAt = session.lastUpdatedAt
    ? new Date(session.lastUpdatedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : undefined;

  const handleClick = () => {
    void navigate({
      to: "/sessions/$sessionId",
      params: { sessionId: session.id },
    });
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="h-auto items-start py-1.5"
        isActive={isActive}
        onClick={handleClick}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs font-medium leading-tight text-muted-foreground">
            {title}
          </span>
          {endedAt && (
            <span className="text-[10px] leading-tight text-muted-foreground/70">
              {endedAt}
            </span>
          )}
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Shows git info if cwd is a git repo, otherwise shows the directory path.
 * - GitHub repo: GitHub pill + branch badge (no folder icon)
 * - Non-GitHub git repo: git icon + filepath + branch badge
 * - No git: folder icon + filepath
 */
function SessionGitOrCwd({
  instanceName,
  cwd,
  cwdShort,
}: {
  instanceName: string;
  cwd?: string;
  cwdShort?: string;
}) {
  const parentPath = cwd ? cwd.replace(/\/[^/]+\/?$/, "") || "/" : undefined;
  const dirName = cwd ? cwd.replace(/\/$/, "").split("/").pop() : undefined;

  const { data: fsData } = useRuntimeFileSystem(instanceName, {
    path: parentPath,
    enabled: !!parentPath,
  });

  const gitEntry = fsData?.entries.find((e) => e.path === dirName && e.git);
  const git = gitEntry?.git;

  if (git) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <GitBranchIcon className="size-2.5 shrink-0" />
        {cwdShort && <span className="truncate">{cwdShort}</span>}
        <GitBadges branch={git.branch} origin={git.origin} />
      </span>
    );
  }

  if (!cwdShort) return null;

  return (
    <span className="flex min-w-0 items-center gap-1">
      <FolderIcon className="size-2.5 shrink-0" />
      <span className="truncate">{cwdShort}</span>
    </span>
  );
}

/** Shorten an absolute path to its last 2 segments for compact display. */
function shortenPath(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return "/" + parts.join("/");
  return parts.slice(-2).join("/");
}

// ─── Runtime Type Item ────────────────────────────────────────────────────────

function RuntimeTypeItem({
  runtime,
  activeTypeName,
  activeInstanceName,
}: {
  runtime: RuntimeInfo;
  activeTypeName?: string;
  activeInstanceName?: string;
}) {
  const navigate = useNavigate();
  const [newInstanceName, setNewInstanceName] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [pendingInstance, setPendingInstance] = useState<string | null>(null);

  const startMutation = useStartRuntime({
    onMutate: ({ name }) => setPendingInstance(name ?? null),
    onError: (err, vars) => {
      toast.error("Failed to start runtime", { description: String(err.message) });
      if (vars.name && !runtime.instances.some((i) => i.name === vars.name)) {
        setNewInstanceName(vars.name);
        setShowInput(true);
      }
    },
    onSettled: () => setPendingInstance(null),
  });

  const stopMutation = useStopRuntime({
    onMutate: (name) => setPendingInstance(name),
    onError: (err) => toast.error("Failed to stop runtime", { description: String(err.message) }),
    onSettled: () => setPendingInstance(null),
  });

  const pauseMutation = usePauseRuntime({
    onMutate: (name) => setPendingInstance(name),
    onError: (err) => toast.error("Failed to pause runtime", { description: String(err.message) }),
    onSettled: () => setPendingInstance(null),
  });

  const deleteMutation = useDeleteRuntime({
    onMutate: (name) => setPendingInstance(name),
    onSuccess: () => {
      void navigate({ to: "/" });
    },
    onError: (err) => toast.error("Failed to delete runtime", { description: String(err.message) }),
    onSettled: () => setPendingInstance(null),
  });

  const isBusy =
    startMutation.isPending ||
    stopMutation.isPending ||
    pauseMutation.isPending ||
    deleteMutation.isPending;

  const isActiveType = activeTypeName === runtime.typeName;

  const navigateToRuntime = (typeName: string, instanceName?: string) => {
    if (instanceName) {
      void navigate({
        to: "/runtimes/$typeName/$instanceName",
        params: { typeName, instanceName },
      });
    } else {
      void navigate({
        to: "/runtimes/$typeName",
        params: { typeName },
      });
    }
  };

  if (runtime.onlyOne) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={isActiveType}
          onClick={() => navigateToRuntime(runtime.typeName)}
        >
          <span className="truncate font-medium">{runtime.typeName}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="font-medium"
          isActive={isActiveType && !activeInstanceName}
          onClick={() => navigateToRuntime(runtime.typeName)}
        >
          {runtime.typeName}
        </SidebarMenuButton>
        <SidebarMenuAction
          showOnHover
          title="Add instance"
          className="z-10 !top-1/2 right-1 !-translate-y-1/2 size-7 cursor-pointer rounded-md hover:bg-muted"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowInput(true);
          }}
        >
          <PlusIcon className="size-3.5 shrink-0" />
        </SidebarMenuAction>
      </SidebarMenuItem>

      {showInput && (
        <SidebarMenuItem>
          <form
            className="flex w-full gap-1 px-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newInstanceName.trim();
              if (name) {
                setShowInput(false);
                setNewInstanceName("");
                startMutation.mutate({ typeName: runtime.typeName, name });
              }
            }}
          >
            <input
              type="text"
              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
              placeholder="Instance name"
              value={newInstanceName}
              onChange={(e) => setNewInstanceName(e.target.value)}
              autoFocus
              onBlur={() => {
                if (!newInstanceName.trim()) setShowInput(false);
              }}
            />
          </form>
        </SidebarMenuItem>
      )}

      {pendingInstance &&
        startMutation.isPending &&
        !runtime.instances.some((i) => i.name === pendingInstance) && (
          <SidebarMenuItem>
            <SidebarMenuButton className="pl-6 text-sm" disabled>
              <span className="truncate">{pendingInstance}</span>
              <span className="ml-auto shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none bg-muted text-muted-foreground">
                <LoaderCircleIcon className="size-3 animate-spin" />
                starting
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}

      {runtime.instances.map((instance) => {
        const isThisPending = pendingInstance === instance.name && isBusy;
        const isDeleting = isThisPending && deleteMutation.isPending;
        return (
          <SidebarMenuItem key={instance.name}>
            <SidebarMenuButton
              className="pl-6 text-sm"
              isActive={isActiveType && activeInstanceName === instance.name}
              onClick={() => navigateToRuntime(runtime.typeName, instance.name)}
              disabled={isDeleting}
            >
              <span className={cn("truncate", isDeleting && "opacity-50")}>{instance.name}</span>
              {isDeleting ? (
                <span className="ml-auto shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none bg-red-500/15 text-red-700 dark:text-red-400">
                  <LoaderCircleIcon className="size-3 animate-spin" />
                  deleting
                </span>
              ) : (
                <span
                  className={cn(
                    "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none",
                    instance.status === "running"
                      ? "bg-green-500/15 text-green-700 dark:text-green-400"
                      : instance.status === "paused"
                        ? "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {instance.status}
                </span>
              )}
            </SidebarMenuButton>
            {isDeleting ? null : instance.status === "running" ? (
              <span className="absolute right-0.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100">
                <button
                  type="button"
                  title="Pause instance"
                  disabled={isBusy}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    pauseMutation.mutate(instance.name);
                  }}
                >
                  {isThisPending && pauseMutation.isPending ? (
                    <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <PauseIcon className="size-3.5 shrink-0" />
                  )}
                </button>
                <button
                  type="button"
                  title="Stop instance"
                  disabled={isBusy}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    stopMutation.mutate(instance.name);
                  }}
                >
                  {isThisPending && stopMutation.isPending ? (
                    <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <SquareIcon className="size-3.5 shrink-0" />
                  )}
                </button>
              </span>
            ) : (
              <span className="absolute right-0.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100">
                <button
                  type="button"
                  title="Resume instance"
                  disabled={isBusy}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    startMutation.mutate({ typeName: runtime.typeName, name: instance.name });
                  }}
                >
                  {isThisPending && startMutation.isPending ? (
                    <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <PlayIcon className="size-3.5 shrink-0" />
                  )}
                </button>
                <button
                  type="button"
                  title="Delete instance"
                  disabled={isBusy}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    deleteMutation.mutate(instance.name);
                  }}
                >
                  {isThisPending && deleteMutation.isPending ? (
                    <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Trash2Icon className="size-3.5 shrink-0" />
                  )}
                </button>
              </span>
            )}
          </SidebarMenuItem>
        );
      })}
    </>
  );
}

function BackendUrlSetting() {
  const { backendUrl, defaultUrl, setBackendUrl, resetBackendUrl } = useBackendUrl();
  const [draft, setDraft] = useState(backendUrl);
  const [open, setOpen] = useState(false);

  const isCustom = backendUrl !== defaultUrl;
  const isDirty = draft !== backendUrl;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setDraft(backendUrl);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted transition-colors cursor-pointer",
            isCustom && "text-foreground",
          )}
        >
          <SettingsIcon className="size-3.5 shrink-0" />
          <span className="truncate">{isCustom ? backendUrl : "Backend URL"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const url = draft.trim();
            if (url) {
              setBackendUrl(url);
              setOpen(false);
              toast.success("Backend URL updated");
            }
          }}
        >
          <label className="text-xs font-medium text-muted-foreground" htmlFor="backend-url-input">
            Backend URL
          </label>
          <div className="mt-1.5 flex items-center gap-1.5">
            <input
              id="backend-url-input"
              type="url"
              className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              placeholder={defaultUrl}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <button
              type="submit"
              disabled={!isDirty || !draft.trim()}
              title="Save"
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-input hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
            >
              <CheckIcon className="size-4" />
            </button>
            {isCustom && (
              <button
                type="button"
                title="Reset to default"
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-input hover:bg-muted"
                onClick={() => {
                  resetBackendUrl();
                  setDraft(defaultUrl);
                  setOpen(false);
                  toast.success("Backend URL reset to default");
                }}
              >
                <RotateCcwIcon className="size-4" />
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Default: {defaultUrl}</p>
        </form>
      </PopoverContent>
    </Popover>
  );
}
