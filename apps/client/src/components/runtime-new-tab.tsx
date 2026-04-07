import {
  useAgentTemplates,
  useRuntimes,
  useCreateSession,
  useRuntimeFileSystem,
} from "@flamecast/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DirectoryPicker } from "@/components/directory-picker";
import { PlayIcon, TerminalIcon, FolderOpenIcon } from "lucide-react";
import { toast } from "sonner";
import { useState, useCallback } from "react";
import type { AgentTemplate } from "@flamecast/sdk/session";
import type { RuntimeInfo } from "@flamecast/protocol/runtime";

export function RuntimeNewTab({
  runtimeTypeName,
  instanceName,
  onSessionCreated,
}: {
  runtimeTypeName: string;
  instanceName: string;
  onSessionCreated: (sessionId: string, agentName: string) => void;
}) {
  const { data: allTemplates = [], isLoading: templatesLoading } = useAgentTemplates();
  const { data: runtimes } = useRuntimes();

  const runtimeInfo = runtimes?.find((rt) => rt.typeName === runtimeTypeName);

  const [cwd, setCwd] = useState<string | undefined>(undefined);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);

  // Fetch the workspace root so we can show the actual default path
  const { data: fsData } = useRuntimeFileSystem(instanceName, { enabled: !cwd });
  const defaultCwd = fsData?.root;

  const createMutation = useCreateSession({
    onError: (err) => toast.error("Failed to create session", { description: String(err.message) }),
  });

  const handleStartSession = useCallback(
    (template: AgentTemplate, runtimeInstance?: string) => {
      const sessionId = crypto.randomUUID();
      // Switch to the session tab immediately — the session tab will show a
      // loading skeleton until the server finishes creating the session.
      onSessionCreated(sessionId, template.name);
      createMutation.mutate({
        sessionId,
        agentTemplateId: template.id,
        runtimeInstance,
        cwd,
      });
    },
    [createMutation, cwd, onSessionCreated],
  );

  const matchingTemplates = allTemplates.filter((t) => t.runtime.provider === runtimeTypeName);
  const displayTemplates = matchingTemplates.length > 0 ? matchingTemplates : allTemplates;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto p-6">
      <div className="w-full max-w-2xl">
        <div className="mb-6 text-center">
          <h2 className="text-lg font-semibold tracking-tight">Start a new session</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose an agent template to launch on{" "}
            <span className="font-medium text-foreground">{instanceName}</span>
            {" in "}
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 rounded px-1 font-medium text-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-primary"
              onClick={() => setDirPickerOpen(true)}
              title="Click to change working directory"
            >
              <FolderOpenIcon className="inline size-3" />
              {cwd ?? defaultCwd ?? "…"}
            </button>
          </p>
        </div>

        <DirectoryPicker
          instanceName={instanceName}
          open={dirPickerOpen}
          onOpenChange={setDirPickerOpen}
          onSelect={(path) => setCwd(path)}
          initialPath={cwd}
        />

        {templatesLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[1, 2].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader className="pb-3">
                  <div className="h-5 w-32 rounded bg-muted" />
                  <div className="h-4 w-48 rounded bg-muted" />
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : displayTemplates.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-8 text-center">
              <TerminalIcon className="mb-3 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm font-medium">No agent templates registered</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Register agent templates from the Agents page to launch sessions.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {displayTemplates.map((template) => (
              <NewTabTemplateCard
                key={template.id}
                template={template}
                runtimeInfo={runtimeInfo}
                instanceName={instanceName}
                onStartSession={(runtimeInstance) => handleStartSession(template, runtimeInstance)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NewTabTemplateCard({
  template,
  runtimeInfo,
  instanceName,
  onStartSession,
}: {
  template: AgentTemplate;
  runtimeInfo?: RuntimeInfo;
  instanceName: string;
  onStartSession: (runtimeInstance?: string) => void;
}) {
  const needsInstanceSelect = runtimeInfo && !runtimeInfo.onlyOne;
  const runningInstances = runtimeInfo?.instances.filter((i) => i.status === "running") ?? [];
  const [selectedInstance, setSelectedInstance] = useState<string>(instanceName);

  return (
    <Card className="group transition-colors hover:border-foreground/20">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <TerminalIcon className="h-4 w-4" />
          </div>
          <CardTitle className="flex-1 text-sm font-semibold">
            {template.name}
            {template.runtime.provider && template.runtime.provider !== "default" && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({template.runtime.provider})
              </span>
            )}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <code className="block truncate rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          {template.spawn.command} {(template.spawn.args ?? []).join(" ")}
        </code>

        {needsInstanceSelect && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Runtime instance</label>
            {runningInstances.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                No running {runtimeInfo.typeName} instances.
              </p>
            ) : (
              <Select value={selectedInstance} onValueChange={setSelectedInstance}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select instance..." />
                </SelectTrigger>
                <SelectContent>
                  {runningInstances.map((inst) => (
                    <SelectItem key={inst.name} value={inst.name} className="text-xs">
                      {inst.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}

        <Button
          size="sm"
          className="w-full"
          onClick={() => onStartSession(needsInstanceSelect ? selectedInstance : instanceName)}
        >
          <PlayIcon data-icon="inline-start" />
          Start session
        </Button>
      </CardContent>
    </Card>
  );
}
