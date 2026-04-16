import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, TerminalIcon, Trash2Icon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "#/components/ui/sidebar";
import { createSession, deleteSession, fetchSessions } from "#/lib/api";

export function TerminalSidebar({
  activeSessionId,
  onSelectSession,
  onNewSession,
}: {
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: (sessionId: string) => void;
}) {
  const queryClient = useQueryClient();

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["terminals"],
    queryFn: fetchSessions,
    refetchInterval: 5000,
  });

  const createMutation = useMutation({
    mutationFn: () => createSession(80, 24),
    onSuccess: (sessionId) => {
      queryClient.invalidateQueries({ queryKey: ["terminals"] });
      onNewSession(sessionId);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["terminals"] });
    },
  });

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3">
        <span className="text-sm font-semibold">Flamecast</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Sessions</SidebarGroupLabel>
          <SidebarGroupAction
            title="New Session"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            <PlusIcon />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <SidebarMenuItem key={i}>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                ))}
              {sessions?.map((session) => (
                <SidebarMenuItem key={session.sessionId}>
                  <SidebarMenuButton
                    isActive={session.sessionId === activeSessionId}
                    onClick={() => onSelectSession(session.sessionId)}
                  >
                    <TerminalIcon />
                    <span className="truncate">{session.sessionId}</span>
                  </SidebarMenuButton>
                  <SidebarMenuAction
                    title="Close session"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMutation.mutate(session.sessionId);
                    }}
                  >
                    <Trash2Icon />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              ))}
              {!isLoading && sessions?.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">No sessions</p>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
