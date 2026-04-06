import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import {
  useAgentTemplates,
  useRuntimes,
  useRuntimeFileSystem,
  useCreateSession,
  useRegisterAgentTemplate,
  useUpdateAgentTemplate,
  useStartRuntimeWithOptimisticUpdate,
  useTerminal,
  useFlamecastClient,
  resolveRuntimeSelection,
} from "@flamecast/ui";
import { FileSystemPanel } from "@/components/filesystem-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { TerminalPanel } from "@/components/terminal-panel";
import {
  LoaderCircleIcon,
  PlusIcon,
  PlayIcon,
  TerminalIcon,
  TerminalSquareIcon,
  SettingsIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import type { AgentTemplate } from "@flamecast/sdk/session";
import type { RuntimeInfo, RuntimeInstance } from "@flamecast/protocol/runtime";

export const Route = createFileRoute("/")({
  component: SessionsPage,
});

/** Parse "KEY=VALUE" lines into a record, ignoring blank/comment lines. */
function parseEnvString(input: string): Record<string, string> | undefined {
  const lines = input
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/** Convert a record back to "KEY=VALUE\n" string for editing. */
function envToString(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function SessionsPage() {
  const navigate = useNavigate();
  // oxlint-disable-next-line no-type-assertion/no-type-assertion -- TanStack Router search params are untyped with strict:false
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const runtimeFilter = typeof search.runtime === "string" ? search.runtime : undefined;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");
  const [newRuntime, setNewRuntime] = useState("");
  const [newSetup, setNewSetup] = useState("");
  const [newEnv, setNewEnv] = useState("");

  const { data: allTemplates = [], isLoading: templatesLoading } = useAgentTemplates();
  const { data: runtimes } = useRuntimes();

  const resolvedTypeName = (() => {
    if (!runtimeFilter || !runtimes) return runtimeFilter;
    for (const rt of runtimes) {
      if (rt.typeName === runtimeFilter) return rt.typeName;
      if (rt.instances.some((i) => i.name === runtimeFilter)) return rt.typeName;
    }
    return runtimeFilter;
  })();

  const templates = resolvedTypeName
    ? allTemplates.filter((t) => t.runtime.provider === resolvedTypeName)
    : allTemplates;

  const createMutation = useCreateSession({
    onSuccess: (session) => navigate({ to: "/sessions/$id", params: { id: session.id } }),
    onError: (err) => toast.error("Failed to create session", { description: String(err.message) }),
  });

  const registerMutation = useRegisterAgentTemplate({
    onSuccess: () => {
      setNewName("");
      setNewCommand("");
      setNewArgs("");
      setNewRuntime("");
      setNewSetup("");
      setNewEnv("");
      setDialogOpen(false);
    },
    onError: (err) =>
      toast.error("Failed to register template", { description: String(err.message) }),
  });

  const handleRegister = () => {
    const name = newName.trim();
    const command = newCommand.trim();
    if (!name || !command) return;
    const args = newArgs.trim() ? newArgs.trim().split(/\s+/).filter(Boolean) : [];
    const provider = newRuntime || undefined;
    const setup = newSetup.trim() || undefined;
    const env = parseEnvString(newEnv);
    registerMutation.mutate({ name, command, args, provider, setup, env });
  };

  const selectedRuntimeSelection = resolveRuntimeSelection(runtimeFilter, runtimes);

  if (selectedRuntimeSelection) {
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col overflow-hidden px-1">
        <RuntimeDetailPanel
          runtimeInfo={selectedRuntimeSelection.runtimeInfo}
          instance={selectedRuntimeSelection.instance}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto px-1">
      <div className="flex flex-col gap-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agent templates</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Register reusable agent templates and launch new sessions.
          </p>
        </div>

        {/* Registered agent templates */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Registered templates
            </h2>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <PlusIcon data-icon="inline-start" />
                  Create
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleRegister();
                  }}
                >
                  <DialogHeader>
                    <DialogTitle>Add agent template</DialogTitle>
                    <DialogDescription>
                      Register a spawn configuration so you can quickly launch sessions from it.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col gap-4 py-4">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="agent-name">Name</Label>
                      <Input
                        id="agent-name"
                        placeholder="My agent"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="agent-command">Command</Label>
                      <Input
                        id="agent-command"
                        placeholder="pnpm"
                        value={newCommand}
                        onChange={(e) => setNewCommand(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="agent-args">Arguments</Label>
                      <Input
                        id="agent-args"
                        placeholder="exec tsx src/agent.ts"
                        value={newArgs}
                        onChange={(e) => setNewArgs(e.target.value)}
                      />
                    </div>
                    {runtimes && runtimes.length > 0 && (
                      <div className="flex flex-col gap-2">
                        <Label>Runtime</Label>
                        <Select value={newRuntime} onValueChange={setNewRuntime}>
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Default" />
                          </SelectTrigger>
                          <SelectContent>
                            {runtimes.map((rt) => (
                              <SelectItem key={rt.typeName} value={rt.typeName} className="text-xs">
                                {rt.typeName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="agent-setup">Setup script</Label>
                      <Textarea
                        id="agent-setup"
                        placeholder="npm install && echo 'ready'"
                        value={newSetup}
                        onChange={(e) => setNewSetup(e.target.value)}
                        rows={2}
                        className="font-mono text-xs"
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="agent-env">Environment variables</Label>
                      <Textarea
                        id="agent-env"
                        placeholder={"NODE_ENV=production\nAPI_KEY=sk-..."}
                        value={newEnv}
                        onChange={(e) => setNewEnv(e.target.value)}
                        rows={2}
                        className="font-mono text-xs"
                      />
                    </div>
                    {newCommand.trim() && (
                      <div className="rounded-md bg-muted px-3 py-2">
                        <p className="text-xs text-muted-foreground">Preview</p>
                        <code className="text-sm">
                          {newCommand.trim()} {newArgs.trim()}
                        </code>
                      </div>
                    )}
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={registerMutation.isPending || !newName.trim() || !newCommand.trim()}
                    >
                      <PlusIcon data-icon="inline-start" />
                      {registerMutation.isPending ? "Saving…" : "Add template"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>

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
          ) : templates.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-8 text-center">
                <TerminalIcon className="mb-3 h-8 w-8 text-muted-foreground/50" />
                <p className="text-sm font-medium">No agent templates registered</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Click "Create" above to add your first agent template.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {templates.map((template) => (
                <AgentTemplateCard
                  key={template.id}
                  template={template}
                  runtimeInfo={runtimes?.find((rt) => rt.typeName === template.runtime.provider)}
                  allRuntimes={runtimes}
                  defaultInstance={runtimeFilter}
                  onStartSession={(runtimeInstance) =>
                    createMutation.mutate({ agentTemplateId: template.id, runtimeInstance })
                  }
                  isStartingSession={
                    createMutation.isPending &&
                    createMutation.variables?.agentTemplateId === template.id
                  }
                  isAnyStarting={createMutation.isPending}
                />
              ))}
            </div>
          )}
        </div>
      </div>
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
          className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden"
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

function AgentTemplateCard({
  template,
  runtimeInfo,
  allRuntimes,
  defaultInstance,
  onStartSession,
  isStartingSession,
  isAnyStarting,
}: {
  template: AgentTemplate;
  runtimeInfo?: RuntimeInfo;
  allRuntimes?: RuntimeInfo[];
  defaultInstance?: string;
  onStartSession: (runtimeInstance?: string) => void;
  isStartingSession: boolean;
  isAnyStarting: boolean;
}) {
  const needsInstanceSelect = runtimeInfo && !runtimeInfo.onlyOne;
  const runningInstances = runtimeInfo?.instances.filter((i) => i.status === "running") ?? [];

  const inferredDefault =
    defaultInstance &&
    defaultInstance !== runtimeInfo?.typeName &&
    runningInstances.some((i) => i.name === defaultInstance)
      ? defaultInstance
      : "";
  const [selectedInstance, setSelectedInstance] = useState<string>(inferredDefault);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState(template.name);
  const [editCommand, setEditCommand] = useState(template.spawn.command);
  const [editArgs, setEditArgs] = useState((template.spawn.args ?? []).join(" "));
  const [editRuntime, setEditRuntime] = useState(template.runtime.provider);
  const [editSetup, setEditSetup] = useState(template.runtime.setup ?? "");
  const [editEnv, setEditEnv] = useState(envToString({ ...template.runtime.env, ...template.env }));

  const updateMutation = useUpdateAgentTemplate(template.id, {
    onSuccess: () => setEditOpen(false),
    onError: (err) =>
      toast.error("Failed to update template", { description: String(err.message) }),
  });

  const handleUpdate = () => {
    const name = editName.trim();
    const command = editCommand.trim();
    if (!name || !command) return;
    const args = editArgs.trim() ? editArgs.trim().split(/\s+/).filter(Boolean) : [];
    const provider = editRuntime;
    const setup = editSetup.trim() || undefined;
    const env = parseEnvString(editEnv);
    updateMutation.mutate({
      name,
      command,
      args,
      provider,
      setup,
      env,
      currentRuntime: template.runtime,
    });
  };

  const canStart = needsInstanceSelect ? Boolean(selectedInstance) : true;

  const allEnvKeys = [
    ...Object.keys(template.runtime.env ?? {}),
    ...Object.keys(template.env ?? {}),
  ].filter((v, i, a) => a.indexOf(v) === i);

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
          <Dialog
            open={editOpen}
            onOpenChange={(open) => {
              setEditOpen(open);
              if (open) {
                setEditName(template.name);
                setEditCommand(template.spawn.command);
                setEditArgs((template.spawn.args ?? []).join(" "));
                setEditRuntime(template.runtime.provider);
                setEditSetup(template.runtime.setup ?? "");
                setEditEnv(envToString({ ...template.runtime.env, ...template.env }));
              }
            }}
          >
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <SettingsIcon className="h-3.5 w-3.5" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleUpdate();
                }}
              >
                <DialogHeader>
                  <DialogTitle>Edit template</DialogTitle>
                  <DialogDescription>
                    Update the configuration for {template.name}.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4 py-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`edit-name-${template.id}`}>Name</Label>
                    <Input
                      id={`edit-name-${template.id}`}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`edit-command-${template.id}`}>Command</Label>
                    <Input
                      id={`edit-command-${template.id}`}
                      value={editCommand}
                      onChange={(e) => setEditCommand(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`edit-args-${template.id}`}>Arguments</Label>
                    <Input
                      id={`edit-args-${template.id}`}
                      value={editArgs}
                      onChange={(e) => setEditArgs(e.target.value)}
                    />
                  </div>
                  {allRuntimes && allRuntimes.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <Label>Runtime</Label>
                      <Select value={editRuntime} onValueChange={setEditRuntime}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {allRuntimes.map((rt) => (
                            <SelectItem key={rt.typeName} value={rt.typeName} className="text-xs">
                              {rt.typeName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`edit-setup-${template.id}`}>Setup script</Label>
                    <Textarea
                      id={`edit-setup-${template.id}`}
                      placeholder="npm install && echo 'ready'"
                      value={editSetup}
                      onChange={(e) => setEditSetup(e.target.value)}
                      rows={3}
                      className="font-mono text-xs"
                      wrap="off"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`edit-env-${template.id}`}>Environment variables</Label>
                    <Textarea
                      id={`edit-env-${template.id}`}
                      placeholder={"NODE_ENV=production\nAPI_KEY=sk-..."}
                      value={editEnv}
                      onChange={(e) => setEditEnv(e.target.value)}
                      rows={3}
                      className="font-mono text-xs"
                      wrap="off"
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={updateMutation.isPending || !editName.trim() || !editCommand.trim()}
                  >
                    {updateMutation.isPending ? "Saving…" : "Save changes"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <code className="block truncate rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          {template.spawn.command} {(template.spawn.args ?? []).join(" ")}
        </code>

        {template.runtime.setup && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Setup</span>
            <code className="block truncate rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
              {template.runtime.setup}
            </code>
          </div>
        )}

        {allEnvKeys.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Environment</span>
            <div className="flex flex-wrap gap-1">
              {allEnvKeys.map((key) => (
                <span
                  key={key}
                  className="inline-block rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  {key}
                </span>
              ))}
            </div>
          </div>
        )}

        {needsInstanceSelect && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Runtime instance</label>
            {runningInstances.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                No running {runtimeInfo.typeName} instances. Start one from the sidebar.
              </p>
            ) : (
              <Select value={selectedInstance} onValueChange={setSelectedInstance}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select instance…" />
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
          onClick={() => onStartSession(needsInstanceSelect ? selectedInstance : undefined)}
          disabled={isAnyStarting || !canStart}
        >
          {isStartingSession ? (
            <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          {isStartingSession ? "Starting…" : "Start session"}
        </Button>
      </CardContent>
    </Card>
  );
}
