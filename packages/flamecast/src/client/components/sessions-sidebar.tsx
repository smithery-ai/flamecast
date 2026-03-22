import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSessions, terminateSession } from "@/client/lib/api";
import { cn } from "@/client/lib/utils";
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
} from "@/client/components/ui/sidebar";
import { Trash2Icon } from "lucide-react";

export function SessionsSidebar() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeSessionId = useRouterState({
    select: (s) => s.matches.find((m) => m.routeId === "/sessions/$id")?.params.id,
  });

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: 3000,
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
          <SidebarGroupLabel>Sessions</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <>
                  <SidebarMenuSkeleton showIcon />
                  <SidebarMenuSkeleton showIcon />
                  <SidebarMenuSkeleton showIcon />
                </>
              ) : !sessions?.length ? (
                <p className="px-2 text-xs text-sidebar-foreground/70">
                  No active sessions. Open the home page to create one.
                </p>
              ) : (
                sessions.map((session) => (
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
