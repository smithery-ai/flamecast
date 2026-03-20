import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createConnection, fetchAgentProcesses, registerAgentProcess } from "@/client/lib/api";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { Label } from "@/client/components/ui/label";
import { Badge } from "@/client/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/client/components/ui/dialog";
import { PlusIcon, PlayIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import type { AgentProcessInfo } from "@/shared/connection";

export const Route = createFileRoute("/")({
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");

  const { data: processes = [], isLoading: processesLoading } = useQuery({
    queryKey: ["agent-processes"],
    queryFn: fetchAgentProcesses,
  });

  const createMutation = useMutation({
    mutationFn: (agentProcessId: string) => createConnection({ agentProcessId, cwd: undefined }),
    onSuccess: (conn) => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      navigate({ to: "/connections/$id", params: { id: conn.id } });
    },
  });

  const registerMutation = useMutation({
    mutationFn: (body: { label: string; command: string; args: string[] }) =>
      registerAgentProcess({
        label: body.label,
        spawn: { command: body.command, args: body.args },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-processes"] });
      setNewLabel("");
      setNewCommand("");
      setNewArgs("");
      setDialogOpen(false);
    },
  });

  const handleRegister = () => {
    const label = newLabel.trim();
    const command = newCommand.trim();
    if (!label || !command) return;
    const args = newArgs.trim() ? newArgs.trim().split(/\s+/).filter(Boolean) : [];
    registerMutation.mutate({ label, command, args });
  };

  return (
    <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto px-1">
      <div className="flex flex-col gap-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Register agent processes and launch new connections.
          </p>
        </div>

        {/* Registered agents */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Registered agents
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
                    <DialogTitle>Add agent process</DialogTitle>
                    <DialogDescription>
                      Register a spawn configuration so you can quickly launch connections to it.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col gap-4 py-4">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="agent-label">Label</Label>
                      <Input
                        id="agent-label"
                        placeholder="My agent"
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="agent-command">Command</Label>
                      <Input
                        id="agent-command"
                        placeholder="npx"
                        value={newCommand}
                        onChange={(e) => setNewCommand(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="agent-args">Arguments</Label>
                      <Input
                        id="agent-args"
                        placeholder="tsx src/agent.ts"
                        value={newArgs}
                        onChange={(e) => setNewArgs(e.target.value)}
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
                      disabled={
                        registerMutation.isPending || !newLabel.trim() || !newCommand.trim()
                      }
                    >
                      <PlusIcon data-icon="inline-start" />
                      {registerMutation.isPending ? "Saving…" : "Add agent"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          {processesLoading ? (
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
          ) : processes.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-8 text-center">
                <TerminalIcon className="mb-3 h-8 w-8 text-muted-foreground/50" />
                <p className="text-sm font-medium">No agents registered</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Click "Create" above to add your first agent process.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {processes.map((proc) => (
                <AgentCard
                  key={proc.id}
                  process={proc}
                  onConnect={() => createMutation.mutate(proc.id)}
                  isConnecting={createMutation.isPending}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentCard({
  process,
  onConnect,
  isConnecting,
}: {
  process: AgentProcessInfo;
  onConnect: () => void;
  isConnecting: boolean;
}) {
  return (
    <Card className="group transition-colors hover:border-foreground/20">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <TerminalIcon className="h-4 w-4" />
          </div>
          <CardTitle className="text-sm font-semibold">{process.label}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <code className="block truncate rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          {process.spawn.command} {(process.spawn.args ?? []).join(" ")}
        </code>
        <Button size="sm" className="w-full" onClick={onConnect} disabled={isConnecting}>
          <PlayIcon data-icon="inline-start" />
          Connect
        </Button>
      </CardContent>
    </Card>
  );
}
