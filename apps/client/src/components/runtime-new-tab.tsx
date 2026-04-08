import {
  useAgentTemplates,
  useRuntimes,
  useCreateSession,
  useRuntimeFileSystem,
} from "@flamecast/ui";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DirectoryPicker } from "@/components/directory-picker";
import { GitWorktreeMenu, useActiveBranch } from "@/components/git-worktree-picker";
import { PlayIcon, FolderOpenIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { useState, useCallback } from "react";
import { Link } from "@tanstack/react-router";

export function RuntimeNewTab({
  runtimeTypeName,
  instanceName,
  onSessionCreated,
}: {
  runtimeTypeName: string;
  instanceName: string;
  onSessionCreated: (sessionId: string, agentName: string, cwd?: string) => void;
}) {
  const { data: allTemplates = [], isLoading: templatesLoading } = useAgentTemplates();
  const { data: runtimes } = useRuntimes();

  const runtimeInfo = runtimes?.find((rt) => rt.typeName === runtimeTypeName);

  const [cwd, setCwd] = useState<string | undefined>(undefined);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);

  // Fetch workspace root (when no cwd selected) and current dir info (for git detection)
  const { data: rootFsData } = useRuntimeFileSystem(instanceName, { enabled: !cwd });
  const { data: cwdFsData } = useRuntimeFileSystem(instanceName, {
    enabled: !!cwd,
    path: cwd,
  });
  const fsData = cwd ? cwdFsData : rootFsData;
  const defaultCwd = rootFsData?.root;
  const gitPath = fsData?.gitPath;
  const activeBranch = useActiveBranch(instanceName, gitPath, cwd ?? defaultCwd ?? "");

  // Agent template selection
  const matchingTemplates = allTemplates.filter((t) => t.runtime.provider === runtimeTypeName);
  const displayTemplates = matchingTemplates.length > 0 ? matchingTemplates : allTemplates;
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const selectedTemplate = selectedTemplateId
    ? allTemplates.find((t) => t.id === selectedTemplateId)
    : displayTemplates[0];

  // Multi-instance runtime selection
  const needsInstanceSelect = runtimeInfo && !runtimeInfo.onlyOne;
  const runningInstances = runtimeInfo?.instances.filter((i) => i.status === "running") ?? [];
  const [selectedInstance, setSelectedInstance] = useState<string>(instanceName);

  const createMutation = useCreateSession({
    onError: (err) => toast.error("Failed to create session", { description: String(err.message) }),
  });

  const handleStartSession = useCallback(() => {
    if (!selectedTemplate) return;
    const sessionId = crypto.randomUUID();
    const runtimeInstance = needsInstanceSelect ? selectedInstance : instanceName;
    onSessionCreated(sessionId, selectedTemplate.name, cwd);
    createMutation.mutate({
      sessionId,
      agentTemplateId: selectedTemplate.id,
      runtimeInstance,
      cwd,
    });
  }, [createMutation, cwd, onSessionCreated, selectedTemplate, needsInstanceSelect, selectedInstance, instanceName]);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto p-6">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <h2 className="text-lg font-semibold tracking-tight">
            Start a new{" "}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-1 rounded px-1 font-semibold underline decoration-dashed underline-offset-2 transition-colors hover:text-primary"
                >
                  {templatesLoading
                    ? "…"
                    : selectedTemplate
                      ? selectedTemplate.name
                      : "agent"}
                  <ChevronDownIcon className="inline size-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {displayTemplates.map((t) => (
                  <DropdownMenuItem
                    key={t.id}
                    onSelect={() => setSelectedTemplateId(t.id)}
                  >
                    {t.name}
                    {t.runtime.provider !== runtimeTypeName && (
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {t.runtime.provider}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
                {displayTemplates.length === 0 && (
                  <DropdownMenuItem disabled>No agents registered</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/agents">
                    <PlusIcon className="size-3.5" />
                    Create new
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>{" "}
            session in{" "}
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 rounded px-1 font-medium underline decoration-dashed underline-offset-2 transition-colors hover:text-primary"
              onClick={() => setDirPickerOpen(true)}
              title="Click to change working directory"
            >
              <FolderOpenIcon className="inline size-3.5" />
              {cwd ?? defaultCwd ?? "…"}
            </button>
            {gitPath && activeBranch && (
              <>
                {" on "}
                <GitWorktreeMenu
                  instanceName={instanceName}
                  gitPath={gitPath}
                  activeBranch={activeBranch}
                  onSelect={(path) => setCwd(path)}
                />
              </>
            )}
          </h2>
        </div>

        <DirectoryPicker
          instanceName={instanceName}
          open={dirPickerOpen}
          onOpenChange={setDirPickerOpen}
          onSelect={(path) => setCwd(path)}
          initialPath={cwd}
        />

        <div className="mx-auto flex max-w-sm flex-col gap-4">
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
            className="w-full"
            disabled={!selectedTemplate || createMutation.isPending}
            onClick={handleStartSession}
          >
            <PlayIcon data-icon="inline-start" />
            Go
          </Button>
        </div>
      </div>
    </div>
  );
}
