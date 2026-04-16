import { LoaderCircleIcon, PlusIcon, TerminalIcon, Trash2Icon } from "lucide-react";
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
import type { TerminalSession } from "#/lib/api";

export function TerminalSidebar({
  activeSessionId,
  deletingSessionId,
  emptyStateMessage,
  isCreatingSession,
  isLoadingSessions,
  onCreateSession,
  onDeleteSession,
  onSelectSession,
  sessions,
}: {
  activeSessionId: string | null;
  deletingSessionId: string | null;
  emptyStateMessage: string | null;
  isCreatingSession: boolean;
  isLoadingSessions: boolean;
  onCreateSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  onSelectSession: (sessionId: string) => void;
  sessions: TerminalSession[];
}) {
  const showLoadingSkeletons = isLoadingSessions || (isCreatingSession && sessions.length === 0);

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
            onClick={onCreateSession}
            disabled={isCreatingSession}
          >
            <PlusIcon />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {showLoadingSkeletons &&
                Array.from({ length: 3 }).map((_, i) => (
                  <SidebarMenuItem key={i}>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                ))}
              {sessions.map((session) => (
                <SidebarMenuItem key={session.sessionId}>
                  <SidebarMenuButton
                    isActive={session.sessionId === activeSessionId}
                    disabled={deletingSessionId === session.sessionId}
                    onClick={() => onSelectSession(session.sessionId)}
                  >
                    {deletingSessionId === session.sessionId ? (
                      <LoaderCircleIcon className="animate-spin" />
                    ) : (
                      <TerminalIcon />
                    )}
                    <span className="truncate">{session.sessionId}</span>
                  </SidebarMenuButton>
                  <SidebarMenuAction
                    title="Close session"
                    disabled={deletingSessionId === session.sessionId}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSession(session.sessionId);
                    }}
                  >
                    <Trash2Icon />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              ))}
              {!showLoadingSkeletons && sessions.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  {emptyStateMessage ?? "No terminals"}
                </p>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
