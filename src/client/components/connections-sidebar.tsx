import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchConnections, killConnection } from "@/client/lib/api";
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
  SidebarSeparator,
} from "@/client/components/ui/sidebar";
import { HomeIcon, Trash2Icon } from "lucide-react";

export function ConnectionsSidebar() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeConnectionId = useRouterState({
    select: (s) => s.matches.find((m) => m.routeId === "/connections/$id")?.params.id,
  });

  const { data: connections, isLoading } = useQuery({
    queryKey: ["connections"],
    queryFn: fetchConnections,
    refetchInterval: 3000,
  });

  const killMutation = useMutation({
    mutationFn: killConnection,
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      if (id === activeConnectionId) {
        void navigate({ to: "/" });
      }
    },
  });

  return (
    <Sidebar>
      <SidebarHeader className="h-14 shrink-0 justify-center">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link to="/">
                <span className="text-lg">🔥</span>
                <span className="truncate font-bold">Flamecast</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Connections</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <>
                  <SidebarMenuSkeleton showIcon />
                  <SidebarMenuSkeleton showIcon />
                  <SidebarMenuSkeleton showIcon />
                </>
              ) : !connections?.length ? (
                <p className="px-2 text-xs text-sidebar-foreground/70">
                  No active connections. Open the home page to create one.
                </p>
              ) : (
                connections.map((conn) => (
                  <SidebarMenuItem key={conn.id}>
                    <SidebarMenuButton
                      asChild
                      isActive={conn.id === activeConnectionId}
                      tooltip={`${conn.agentLabel} · ${conn.id.slice(0, 8)}…`}
                      className="!h-auto min-h-8 items-start py-2"
                    >
                      <Link to="/connections/$id" params={{ id: conn.id }}>
                        <span className="grid min-w-0 flex-1 gap-1 leading-snug">
                          <span className="truncate font-medium">{conn.agentLabel}</span>
                          <span className="truncate text-xs text-sidebar-foreground/65">
                            {conn.sessionId.slice(0, 10)}… · {conn.logs.length} entries
                          </span>
                        </span>
                      </Link>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      title="Close connection"
                      disabled={killMutation.isPending}
                      className="z-10 !top-1/2 right-1 !-translate-y-1/2 text-sidebar-foreground hover:!text-destructive"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        killMutation.mutate(conn.id);
                      }}
                    >
                      <Trash2Icon className="text-destructive" />
                      <span className="sr-only">Close connection</span>
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarSeparator />
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === "/"} tooltip="Home">
              <Link to="/">
                <HomeIcon />
                <span>Home & new connection</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
