import { createFileRoute } from "@tanstack/react-router";
import {
  useRuntimes,
  useRuntimeFileSystem,
  useStartRuntimeWithOptimisticUpdate,
  useTerminal,
  useFlamecastClient,
} from "@flamecast/ui";
import { FileSystemPanel } from "@/components/filesystem-panel";
import { TerminalPanel } from "@/components/terminal-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { LoaderCircleIcon, PlayIcon, TerminalSquareIcon } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import type { RuntimeInfo, RuntimeInstance } from "@flamecast/protocol/runtime";

export const Route = createFileRoute("/runtimes/$typeName/$instanceName")({
  component: RuntimeInstancePage,
});

function RuntimeInstancePage() {
  const { typeName, instanceName } = Route.useParams();
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
    <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col overflow-hidden px-1">
      <RuntimeDetailPanel runtimeInfo={runtimeInfo} instance={instance} />
    </div>
  );
}

function RuntimeDetailPanel({
  runtimeInfo,
  instance,
}: {
  runtimeInfo: RuntimeInfo;
  instance: RuntimeInstance;
}) {
  const client = useFlamecastClient();
  const [showAllFiles, setShowAllFiles] = useState(false);
  const isRunning = instance.status === "running";

  const runtimeFsQuery = useRuntimeFileSystem(instance.name, {
    enabled: isRunning,
    showAllFiles,
  });

  const { terminals, sendInput, resize, onData, createTerminal, killTerminal } = useTerminal(
    isRunning ? instance.websocketUrl : undefined,
  );

  const startMutation = useStartRuntimeWithOptimisticUpdate(runtimeInfo, {
    instanceName: instance.name,
    onError: (err) => toast.error("Failed to start runtime", { description: String(err.message) }),
  });

  if (!isRunning) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden">
        <div className="shrink-0">
          <h1 className="text-2xl font-bold tracking-tight">{instance.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {runtimeInfo.typeName === instance.name
              ? `${instance.status} runtime`
              : `${runtimeInfo.typeName} runtime`}
          </p>
        </div>
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">
              {startMutation.isPending ? "Starting runtime..." : "Runtime not running"}
            </CardTitle>
            <CardDescription>
              {startMutation.isPending
                ? "Waiting for the runtime instance to come up."
                : `This runtime is currently ${instance.status}. Start it to browse its workspace.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
              {startMutation.isPending ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {startMutation.isPending ? "Starting..." : "Start runtime"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="shrink-0">
        <h1 className="text-2xl font-bold tracking-tight">{instance.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {runtimeInfo.typeName === instance.name
            ? `${instance.status} runtime`
            : `${runtimeInfo.typeName} runtime`}
        </p>
      </div>

      <Tabs defaultValue="terminals" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <TabsList>
          <TabsTrigger value="terminals">
            <TerminalSquareIcon className="size-3.5" />
            Terminals
            {terminals.length > 0 && (
              <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 text-[10px]">
                {terminals.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>

        <TabsContent
          value="terminals"
          forceMount
          className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
        >
          <TerminalPanel
            terminals={terminals}
            sendInput={sendInput}
            resize={resize}
            onData={onData}
            onCreateTerminal={() => createTerminal()}
            onRemoveTerminal={killTerminal}
          />
        </TabsContent>

        <TabsContent value="files" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          {runtimeFsQuery.isLoading ? (
            <Card className="flex min-h-[28rem] items-center justify-center">
              <CardContent className="flex items-center gap-3 py-10 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" />
                Loading runtime filesystem...
              </CardContent>
            </Card>
          ) : runtimeFsQuery.isError || !runtimeFsQuery.data ? (
            <Card className="border-dashed">
              <CardHeader>
                <CardTitle className="text-base">Could not load runtime filesystem</CardTitle>
                <CardDescription>
                  {runtimeFsQuery.error instanceof Error
                    ? runtimeFsQuery.error.message
                    : "Unknown error"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" onClick={() => void runtimeFsQuery.refetch()}>
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : (
            <FileSystemPanel
              workspaceRoot={runtimeFsQuery.data.root}
              entries={runtimeFsQuery.data.entries}
              showAllFiles={showAllFiles}
              onShowAllFilesChange={setShowAllFiles}
              loadPreview={(path) => client.fetchRuntimeFilePreview(instance.name, path)}
              emptyTreeMessage="No filesystem entries returned for this runtime."
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
