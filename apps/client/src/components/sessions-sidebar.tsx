import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  useRuntimes,
  useStartRuntime,
  useStopRuntime,
  usePauseRuntime,
} from "@flamecast/ui";
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
} from "@/components/ui/sidebar";
import {
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { RuntimeInfo } from "@flamecast/protocol/runtime";

export function SessionsSidebar() {
  const { activeRuntimeTypeName, activeRuntimeInstanceName } = useRouterState({
    select: (s) => {
      const runtimeMatch = s.matches.find(
        (m) =>
          m.routeId === "/runtimes/$typeName/$instanceName" || m.routeId === "/runtimes/$typeName",
      );
      const instanceMatch = s.matches.find(
        (m) => m.routeId === "/runtimes/$typeName/$instanceName",
      );
      return {
        activeRuntimeTypeName: runtimeMatch?.params.typeName,
        activeRuntimeInstanceName: instanceMatch?.params.instanceName,
      };
    },
  });
  const { data: runtimes } = useRuntimes();

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

        {runtimes && runtimes.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Runtimes</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {runtimes.map((rt) => (
                  <RuntimeTypeItem
                    key={rt.typeName}
                    runtime={rt}
                    activeTypeName={activeRuntimeTypeName}
                    activeInstanceName={activeRuntimeInstanceName}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

      </SidebarContent>
    </Sidebar>
  );
}

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

  const isBusy = startMutation.isPending || stopMutation.isPending || pauseMutation.isPending;

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
        return (
          <SidebarMenuItem key={instance.name}>
            <SidebarMenuButton
              className="pl-6 text-sm"
              isActive={isActiveType && activeInstanceName === instance.name}
              onClick={() => navigateToRuntime(runtime.typeName, instance.name)}
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
            {instance.status === "running" ? (
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
