import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchRuntimes,
  fetchSessions,
  pauseRuntime,
  startRuntime,
  stopRuntime,
  terminateSession,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
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
import {
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { RuntimeInfo } from "@flamecast/protocol/runtime";

/**
 * Resolve a `?runtime=X` filter value to its parent type name.
 * If X is a type name directly, returns it. If X is a multi-instance
 * instance name, returns the owning type name.
 */
function resolveTypeName(filter: string, runtimes: RuntimeInfo[]): string | undefined {
  for (const rt of runtimes) {
    if (rt.typeName === filter) return rt.typeName;
    if (rt.instances.some((i) => i.name === filter)) return rt.typeName;
  }
  return undefined;
}

export function SessionsSidebar() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // oxlint-disable-next-line no-type-assertion/no-type-assertion -- TanStack Router search params are untyped with strict:false
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const runtimeFilter = typeof search.runtime === "string" ? search.runtime : undefined;
  const activeSessionId = useRouterState({
    select: (s) => s.matches.find((m) => m.routeId === "/sessions/$id")?.params.id,
  });

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: 30_000,
  });

  const { data: runtimes } = useQuery({
    queryKey: ["runtimes"],
    queryFn: fetchRuntimes,
    refetchInterval: 30_000,
  });

  const terminateMutation = useMutation({
    mutationFn: terminateSession,
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      if (id === activeSessionId) {
        void navigate({ to: "/" });
      }
    },
  });

  // Filter sessions: match by instance name directly, or if the filter is
  // a type name, match all sessions whose runtime is that type or any of
  // its instances.
  const filteredSessions = (() => {
    if (!runtimeFilter || !sessions) return sessions;
    const typeName = runtimes ? resolveTypeName(runtimeFilter, runtimes) : undefined;
    // Collect all instance names for the resolved type
    const matchingType = runtimes?.find((rt) => rt.typeName === typeName);
    const instanceNames = new Set(matchingType?.instances.map((i) => i.name) ?? []);
    if (typeName) instanceNames.add(typeName);

    if (runtimeFilter === typeName) {
      // Clicked a type heading — show all sessions for that type
      return sessions.filter((s) => s.runtime && instanceNames.has(s.runtime));
    }
    // Clicked a specific instance — show only sessions for that instance
    return sessions.filter((s) => s.runtime === runtimeFilter);
  })();

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
        {/* Runtimes group */}
        {runtimes && runtimes.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Runtimes</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {runtimes.map((rt) => (
                  <RuntimeTypeItem key={rt.typeName} runtime={rt} activeFilter={runtimeFilter} />
                ))}
                {runtimeFilter && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      className="text-xs text-sidebar-foreground/70"
                      onClick={() => void navigate({ to: "/", search: {} })}
                    >
                      Clear filter
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Sessions group */}
        <SidebarGroup>
          <SidebarGroupLabel>
            Sessions{runtimeFilter ? ` (${runtimeFilter})` : ""}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <>
                  <SidebarMenuSkeleton showIcon />
                  <SidebarMenuSkeleton showIcon />
                  <SidebarMenuSkeleton showIcon />
                </>
              ) : !filteredSessions?.length ? (
                <p className="px-2 text-xs text-sidebar-foreground/70">
                  No active sessions. Open the home page to create one.
                </p>
              ) : (
                filteredSessions.map((session) => (
                  <SidebarMenuItem key={session.id}>
                    <SidebarMenuButton
                      asChild
                      isActive={session.id === activeSessionId}
                      tooltip={`${session.agentName} · ${session.id.slice(0, 8)}…`}
                      className="!h-auto min-h-8 items-start py-2 pr-10"
                    >
                      <Link to="/sessions/$id" params={{ id: session.id }}>
                        <span className="grid min-w-0 flex-1 gap-1 leading-snug">
                          <span className="truncate font-medium">{session.agentName}</span>
                          <span className="truncate text-xs text-sidebar-foreground/65">
                            {session.id.slice(0, 10)}… · {session.logs.length} entries
                          </span>
                        </span>
                      </Link>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      title="Terminate session"
                      disabled={terminateMutation.isPending}
                      className={cn(
                        "z-10 !top-1/2 right-1 !-translate-y-1/2 size-8 cursor-pointer rounded-md",
                        "text-destructive/90 transition-[opacity,transform,colors] duration-150",
                        "hover:bg-destructive/15 hover:text-destructive active:scale-95",
                        "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                        "md:pointer-events-none md:group-hover/menu-item:pointer-events-auto md:group-focus-within/menu-item:pointer-events-auto",
                        "disabled:pointer-events-none disabled:opacity-40",
                      )}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        terminateMutation.mutate(session.id);
                      }}
                    >
                      <Trash2Icon className="size-4 shrink-0" />
                      <span className="sr-only">Terminate session</span>
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function RuntimeTypeItem({
  runtime,
  activeFilter,
}: {
  runtime: RuntimeInfo;
  activeFilter?: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [newInstanceName, setNewInstanceName] = useState("");
  const [showInput, setShowInput] = useState(false);
  // Track which instance name has an in-flight action
  const [pendingInstance, setPendingInstance] = useState<string | null>(null);

  const startMutation = useMutation({
    mutationFn: ({ typeName, name }: { typeName: string; name?: string }) =>
      startRuntime(typeName, name),
    onMutate: ({ name }) => setPendingInstance(name ?? null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runtimes"] });
      setNewInstanceName("");
      setShowInput(false);
    },
    onError: (err) => {
      toast.error("Failed to start runtime", { description: String(err.message) });
    },
    onSettled: () => setPendingInstance(null),
  });

  const stopMutation = useMutation({
    mutationFn: stopRuntime,
    onMutate: (name) => setPendingInstance(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runtimes"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (err) => {
      toast.error("Failed to stop runtime", { description: String(err.message) });
    },
    onSettled: () => setPendingInstance(null),
  });

  const pauseMutation = useMutation({
    mutationFn: pauseRuntime,
    onMutate: (name) => setPendingInstance(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runtimes"] });
    },
    onError: (err) => {
      toast.error("Failed to pause runtime", { description: String(err.message) });
    },
    onSettled: () => setPendingInstance(null),
  });

  const isBusy = startMutation.isPending || stopMutation.isPending || pauseMutation.isPending;

  const setFilter = (value: string) => {
    void navigate({
      to: "/",
      search: activeFilter === value ? {} : { runtime: value },
    });
  };

  if (runtime.onlyOne) {
    // Single-instance: just a clickable label, no play/stop (always implicitly running)
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={activeFilter === runtime.typeName}
          onClick={() => setFilter(runtime.typeName)}
        >
          <span className="truncate font-medium">{runtime.typeName}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  // Multi-instance runtime
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="font-medium"
          isActive={activeFilter === runtime.typeName}
          onClick={() => setFilter(runtime.typeName)}
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

      {runtime.instances.map((instance) => {
        const isThisPending = pendingInstance === instance.name && isBusy;
        return (
          <SidebarMenuItem key={instance.name}>
            <SidebarMenuButton
              className="pl-6 text-sm"
              isActive={activeFilter === instance.name}
              onClick={() => setFilter(instance.name)}
            >
              <span className="truncate">{instance.name}</span>
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
            </SidebarMenuButton>
            {/* Action buttons: shown on hover, one at a time based on status */}
            {instance.status === "running" ? (
              // Running: show pause + stop
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
              // Stopped or paused: show play (resume)
              <SidebarMenuAction
                showOnHover
                title="Resume instance"
                disabled={isBusy}
                className="z-10 !top-1/2 right-1 !-translate-y-1/2 size-7 cursor-pointer rounded-md hover:bg-muted"
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
              </SidebarMenuAction>
            )}
          </SidebarMenuItem>
        );
      })}
    </>
  );
}
