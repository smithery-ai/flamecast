import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  useMessageQueue,
  useSendQueuedMessage,
  useRemoveQueuedMessage,
  useClearMessageQueue,
  useRuntimes,
  useSessions,
} from "@flamecast/ui";
import { cn } from "@/lib/utils";
import type { QueuedMessage } from "@/lib/message-queue-context";
import { useQueueSessionStatus, type SessionStatus } from "@/hooks/use-queue-session-status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  CircleIcon,
  InboxIcon,
  FolderIcon,
  LinkIcon,
  LoaderCircleIcon,
  PlayIcon,
  TerminalIcon,
  ServerIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { RuntimeInfo } from "@flamecast/protocol/runtime";
import type { Session } from "@flamecast/protocol/session";

export const Route = createFileRoute("/queue")({
  component: QueuePage,
});

/** Resolve a session to its runtime route params. */
function resolveSessionRoute(
  sessionId: string,
  sessions: Session[] | undefined,
  runtimes: RuntimeInfo[] | undefined,
): { typeName: string; instanceName: string } | null {
  const session = sessions?.find((s) => s.id === sessionId);
  if (!session?.runtime) return null;
  const instanceName = session.runtime;
  for (const rt of runtimes ?? []) {
    if (rt.onlyOne && rt.typeName === instanceName) {
      return { typeName: rt.typeName, instanceName };
    }
    if (rt.instances.some((i) => i.name === instanceName)) {
      return { typeName: rt.typeName, instanceName };
    }
  }
  return null;
}

function QueuePage() {
  const navigate = useNavigate();
  const { data: queue = [] } = useMessageQueue();
  const { isSessionBusy, getStatus } = useQueueSessionStatus(queue);
  const { data: sessions } = useSessions();
  const { data: runtimes } = useRuntimes();
  const [sendingId, setSendingId] = useState<number | null>(null);

  const sendMutation = useSendQueuedMessage({
    onSuccess: () => {
      setSendingId(null);
      toast.success("Prompt sent to session");
    },
    onError: (err) => {
      setSendingId(null);
      toast.error("Failed to send prompt", { description: String(err.message) });
    },
  });

  const removeMutation = useRemoveQueuedMessage({
    onError: (err) => toast.error("Failed to remove", { description: String(err.message) }),
  });

  const clearMutation = useClearMessageQueue({
    onError: (err) => toast.error("Failed to clear", { description: String(err.message) }),
  });

  const handleSendToSession = (item: QueuedMessage) => {
    setSendingId(item.id);
    sendMutation.mutate(item.id);
  };

  const handleGoToChat = useCallback(
    (sessionId: string) => {
      const target = resolveSessionRoute(sessionId, sessions, runtimes);
      if (!target) return;
      void navigate({
        to: "/runtimes/$typeName/$instanceName",
        params: target,
        search: { sessionId },
      });
    },
    [navigate, sessions, runtimes],
  );

  return (
    <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto px-1">
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Message queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Messages queued from the home page and chat sessions. Send them to a session when ready.
          </p>
        </div>

        {queue.length > 0 && (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => clearMutation.mutate()}>
              <Trash2Icon data-icon="inline-start" />
              Clear all
            </Button>
          </div>
        )}

        {queue.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-8 text-center">
              <InboxIcon className="mb-3 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm font-medium">No queued messages</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Messages sent from the home page or chat will appear here.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {(() => {
              // Track which sessions have already shown "action needed"
              // so only the first pending item per session gets the alert.
              const attentionShown = new Set<string>();
              return queue.map((item) => {
                const status = item.sessionId ? getStatus(item.sessionId) : undefined;
                const busy = item.sessionId ? isSessionBusy(item.sessionId) : false;
                const sessionKilled = item.sessionId
                  ? sessions?.find((s) => s.id === item.sessionId)?.status === "killed"
                  : false;
                const sessionNeedsAttention = !!status?.pendingPermission && !sessionKilled;
                // Only the first pending item for this session shows the alert
                const needsAttention =
                  sessionNeedsAttention &&
                  item.status === "pending" &&
                  !!item.sessionId &&
                  !attentionShown.has(item.sessionId);
                if (needsAttention && item.sessionId) {
                  attentionShown.add(item.sessionId);
                }
                const isSending = sendingId === item.id;
                const canSend =
                  !!item.sessionId &&
                  item.status === "pending" &&
                  !busy &&
                  !sendingId &&
                  !sessionKilled;
                return (
                  <QueueItem
                    key={item.id}
                    item={item}
                    isSending={isSending}
                    sendDisabled={!canSend}
                    needsAttention={needsAttention}
                    sessionKilled={!!sessionKilled}
                    sessionBusy={busy}
                    sessionStatus={status}
                    onRemove={() => removeMutation.mutate(item.id)}
                    onSendToSession={() => handleSendToSession(item)}
                    onGoToChat={
                      item.sessionId
                        ? (() => {
                            const sid = item.sessionId;
                            return sid ? () => handleGoToChat(sid) : undefined;
                          })()
                        : undefined
                    }
                  />
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

function QueueItem({
  item,
  isSending,
  sendDisabled,
  needsAttention,
  sessionKilled,
  sessionBusy,
  sessionStatus,
  onRemove,
  onSendToSession,
  onGoToChat,
}: {
  item: QueuedMessage;
  isSending: boolean;
  sendDisabled: boolean;
  needsAttention: boolean;
  sessionKilled: boolean;
  sessionBusy: boolean;
  sessionStatus?: SessionStatus;
  onRemove: () => void;
  onSendToSession: () => void;
  onGoToChat?: () => void;
}) {
  const time = new Date(item.createdAt).toLocaleTimeString();
  const isSent = item.status === "sent";

  // Determine tooltip label for play button
  let tooltipLabel = "Send to session";
  if (sessionKilled) tooltipLabel = "Session ended";
  else if (isSending) tooltipLabel = "Sending...";
  else if (sessionBusy && sessionStatus?.processing) tooltipLabel = "Session processing...";

  return (
    <Card
      className={cn(
        "group transition-colors hover:border-foreground/20",
        isSent && "opacity-60",
        sessionKilled && item.status === "pending" && "border-red-500/50 opacity-60",
        needsAttention && "border-yellow-500/50",
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {isSent && <CheckCircleIcon className="size-3.5 shrink-0 text-green-600" />}
            <CardTitle className="text-sm font-medium leading-snug">{item.text}</CardTitle>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {sessionKilled && item.status === "pending" ? (
              <Badge variant="destructive" className="gap-1 text-xs">
                Session ended
              </Badge>
            ) : needsAttention && onGoToChat ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-yellow-600 hover:text-yellow-700 dark:text-yellow-400 dark:hover:text-yellow-300"
                onClick={onGoToChat}
              >
                <AlertTriangleIcon className="h-3.5 w-3.5" />
                Action needed
              </Button>
            ) : item.sessionId && item.status === "pending" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={onSendToSession}
                      disabled={sendDisabled}
                    >
                      {isSending ? (
                        <LoaderCircleIcon className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <PlayIcon className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left">{tooltipLabel}</TooltipContent>
              </Tooltip>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={onRemove}
            >
              <XIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="gap-1 text-xs">
          <ServerIcon className="size-3" />
          {item.runtime}
        </Badge>
        <Badge variant="secondary" className="gap-1 text-xs">
          <TerminalIcon className="size-3" />
          {item.agent}
        </Badge>
        {item.directory && (
          <Badge variant="secondary" className="gap-1 text-xs">
            <FolderIcon className="size-3" />
            {item.directory}
          </Badge>
        )}
        {item.sessionId && (
          <Badge
            variant="outline"
            className={cn(
              "gap-1 text-xs",
              sessionKilled && "border-red-500/50 text-red-600 dark:text-red-400",
            )}
          >
            <LinkIcon className="size-3" />
            ...{item.sessionId.slice(-8)}
            <CircleIcon
              className={cn(
                "size-1.5 fill-current",
                sessionKilled ? "text-red-500" : sessionBusy ? "text-yellow-500" : "text-green-500",
              )}
            />
          </Badge>
        )}
        {isSent && (
          <Badge variant="default" className="gap-1 text-xs bg-green-600">
            sent
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">{time}</span>
      </CardContent>
    </Card>
  );
}
