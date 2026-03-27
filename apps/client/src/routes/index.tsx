import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSession,
  fetchAgentTemplates,
  fetchRuntimes,
  registerAgentTemplate,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { LoaderCircleIcon, PlusIcon, PlayIcon, TerminalIcon } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import type { AgentTemplate } from "@flamecast/sdk/session";
import type { RuntimeInfo } from "@flamecast/protocol/runtime";

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

function SessionsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // oxlint-disable-next-line no-type-assertion/no-type-assertion -- TanStack Router search params are untyped with strict:false
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const runtimeFilter = typeof search.runtime === "string" ? search.runtime : undefined;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");
  const [newSetup, setNewSetup] = useState("");
  const [newEnv, setNewEnv] = useState("");

  const { data: allTemplates = [], isLoading: templatesLoading } = useQuery({
    queryKey: ["agent-templates"],
    queryFn: fetchAgentTemplates,
  });

  const { data: runtimes } = useQuery({
    queryKey: ["runtimes"],
    queryFn: fetchRuntimes,
    refetchInterval: 30_000,
  });

  // Resolve instance name → type name so templates (which store provider/type)
  // match when filtering by a specific instance like "staging".
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

  const createMutation = useMutation({
    mutationFn: ({
      agentTemplateId,
      runtimeInstance,
    }: {
      agentTemplateId: string;
      runtimeInstance?: string;
    }) => createSession({ agentTemplateId, cwd: undefined, runtimeInstance }),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate({ to: "/sessions/$id", params: { id: session.id } });
    },
    onError: (err) => {
      toast.error("Failed to create session", { description: String(err.message) });
    },
  });

  const registerMutation = useMutation({
    mutationFn: (body: {
      name: string;
      command: string;
      args: string[];
      setup?: string;
      env?: Record<string, string>;
    }) =>
      registerAgentTemplate({
        name: body.name,
        spawn: { command: body.command, args: body.args },
        runtime: {
          ...(body.setup ? { setup: body.setup } : {}),
        },
        ...(body.env && Object.keys(body.env).length > 0 ? { env: body.env } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-templates"] });
      setNewName("");
      setNewCommand("");
      setNewArgs("");
      setNewSetup("");
      setNewEnv("");
      setDialogOpen(false);
    },
    onError: (err) => {
      toast.error("Failed to register template", { description: String(err.message) });
    },
  });

  const handleRegister = () => {
    const name = newName.trim();
    const command = newCommand.trim();
    if (!name || !command) return;
    const args = newArgs.trim() ? newArgs.trim().split(/\s+/).filter(Boolean) : [];
    const setup = newSetup.trim() || undefined;
    const env = parseEnvString(newEnv);
    registerMutation.mutate({ name, command, args, setup, env });
  };

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
              <DialogContent>
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

function AgentTemplateCard({
  template,
  runtimeInfo,
  defaultInstance,
  onStartSession,
  isStartingSession,
  isAnyStarting,
}: {
  template: AgentTemplate;
  runtimeInfo?: RuntimeInfo;
  /** The current ?runtime= filter. If it's a running instance name, pre-select it. */
  defaultInstance?: string;
  onStartSession: (runtimeInstance?: string) => void;
  /** True when THIS template's session is being created. */
  isStartingSession: boolean;
  /** True when ANY session is being created (to disable all buttons). */
  isAnyStarting: boolean;
}) {
  const needsInstanceSelect = runtimeInfo && !runtimeInfo.onlyOne;
  const runningInstances = runtimeInfo?.instances.filter((i) => i.status === "running") ?? [];

  // If the filter points to a specific running instance (not the type name), default to it.
  const inferredDefault =
    defaultInstance &&
    defaultInstance !== runtimeInfo?.typeName &&
    runningInstances.some((i) => i.name === defaultInstance)
      ? defaultInstance
      : "";
  const [selectedInstance, setSelectedInstance] = useState<string>(inferredDefault);

  const canStart = needsInstanceSelect ? Boolean(selectedInstance) : true;

  return (
    <Card className="group transition-colors hover:border-foreground/20">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <TerminalIcon className="h-4 w-4" />
          </div>
          <CardTitle className="text-sm font-semibold">
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

        {template.runtime.setup && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Setup</span>
            <code className="block truncate rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
              {template.runtime.setup}
            </code>
          </div>
        )}

        {(() => {
          const allEnvKeys = [
            ...Object.keys(template.runtime.env ?? {}),
            ...Object.keys(template.env ?? {}),
          ].filter((v, i, a) => a.indexOf(v) === i);
          return allEnvKeys.length > 0 ? (
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
          ) : null;
        })()}

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
