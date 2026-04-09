import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  useRuntimes,
  useStartRuntimeWithOptimisticUpdate,
  useDeleteRuntime,
  useSessions,
} from "@flamecast/ui";
import { RuntimeSessionTab } from "@/components/runtime-session-tab";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoaderCircleIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { useEffect } from "react";
import type { RuntimeInfo, RuntimeInstance } from "@flamecast/protocol/runtime";

export const Route = createFileRoute("/runtimes/$typeName/$instanceName")({
  component: RuntimeInstancePage,
  validateSearch: (search: Record<string, unknown>) => ({
    sessionId: typeof search.sessionId === "string" ? search.sessionId : undefined,
  }),
});

function RuntimeInstancePage() {
  const { typeName, instanceName } = Route.useParams();
  const { sessionId: searchSessionId } = Route.useSearch();
  const { data: runtimes } = useRuntimes();

  const runtimeInfo = runtimes?.find((rt) => rt.typeName === typeName);
  const instance =
    runtimeInfo?.instances.find((i) => i.name === instanceName) ??
    (runtimeInfo?.onlyOne
      ? {
          name: instanceName,
          typeName,
          status: "stopped" as const,
        }
      : undefined);

  if (!runtimeInfo || !instance) {
    return (
      <div className="mx-auto w-full max-w-3xl px-1">
        <h1 className="text-2xl font-bold tracking-tight">Instance not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          No runtime instance "{instanceName}" found in {typeName}.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <RuntimeDetailPanel
        runtimeInfo={runtimeInfo}
        instance={instance}
        focusSessionId={searchSessionId}
      />
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

function RuntimeDetailPanel({
  runtimeInfo,
  instance,
  focusSessionId,
}: {
  runtimeInfo: RuntimeInfo;
  instance: RuntimeInstance;
  focusSessionId?: string;
}) {
  const isRunning = instance.status === "running";
  const { data: sessions } = useSessions();
  const navigate = useNavigate();

  // Find active sessions for this runtime instance
  const instanceSessions =
    sessions?.filter((s) => s.status === "active" && s.runtime === instance.name) ?? [];

  // Determine which session to display
  const activeSessionId = focusSessionId ?? instanceSessions[0]?.id;
  const activeSession = instanceSessions.find((s) => s.id === activeSessionId);

  // Keep URL in sync with the displayed session
  useEffect(() => {
    if (activeSession && activeSession.id !== focusSessionId) {
      void navigate({
        search: { sessionId: activeSession.id },
        replace: true,
      });
    } else if (!activeSession && focusSessionId) {
      void navigate({
        search: {},
        replace: true,
      });
    }
  }, [activeSession, focusSessionId, navigate]);

  const startMutation = useStartRuntimeWithOptimisticUpdate(runtimeInfo, {
    instanceName: instance.name,
    onError: (err) => toast.error("Failed to start runtime", { description: String(err.message) }),
  });

  const deleteMutation = useDeleteRuntime({
    onSuccess: () => void navigate({ to: "/" }),
    onError: (err) => toast.error("Failed to delete runtime", { description: String(err.message) }),
  });

  // ─── Not running state ───────────────────────────────────────────────────

  if (!isRunning) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6">
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">
              {deleteMutation.isPending
                ? "Deleting runtime..."
                : startMutation.isPending
                  ? "Starting runtime..."
                  : "Runtime not running"}
            </CardTitle>
            <CardDescription>
              {deleteMutation.isPending
                ? "Removing the runtime instance and its resources."
                : startMutation.isPending
                  ? "Waiting for the runtime instance to come up."
                  : `${instance.name} is currently ${instance.status}. Start it to begin working.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending || deleteMutation.isPending}
            >
              {startMutation.isPending ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {startMutation.isPending ? "Starting..." : "Start runtime"}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate(instance.name)}
              disabled={startMutation.isPending || deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <Trash2Icon data-icon="inline-start" />
              )}
              {deleteMutation.isPending ? "Deleting..." : "Delete runtime"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ─── No active session ─────────────────────────────────────────────────

  if (!activeSession) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground">
          No active session. Start one from the home page.
        </p>
        <Button variant="outline" onClick={() => void navigate({ to: "/" })}>
          Go to Home
        </Button>
      </div>
    );
  }

  // ─── Session view ──────────────────────────────────────────────────────

  return (
    <RuntimeSessionTab
      sessionId={activeSession.id}
      instanceName={instance.name}
      runtimeWebsocketUrl={instance.websocketUrl}
      cwd={activeSession.cwd}
    />
  );
}
