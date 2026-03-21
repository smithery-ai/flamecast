import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createAgent, fetchAgentTemplates, registerAgentTemplate } from "@/client/lib/api";
import { AgentAcpClient } from "@/client/lib/agent-acp";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { Label } from "@/client/components/ui/label";
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
import type { AgentTemplate } from "@/shared/session";

export const Route = createFileRoute("/")({
  component: AgentsPage,
});

function AgentsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");

  const { data: templates = [], isLoading: templatesLoading } = useQuery({
    queryKey: ["agent-templates"],
    queryFn: fetchAgentTemplates,
  });

  const createMutation = useMutation({
    mutationFn: async (agentTemplateId: string) => {
      const agent = await createAgent({ agentTemplateId });
      const acpClient = new AgentAcpClient(agent.id);
      try {
        const session = await acpClient.createSession(".");
        return { agent, sessionId: session.sessionId };
      } finally {
        await acpClient.close();
      }
    },
    onSuccess: ({ agent, sessionId }) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      navigate({
        to: "/agents/$agentId/sessions/$sessionId",
        params: { agentId: agent.id, sessionId },
      });
    },
  });

  const registerMutation = useMutation({
    mutationFn: (body: { name: string; command: string; args: string[] }) =>
      registerAgentTemplate({
        name: body.name,
        spawn: { command: body.command, args: body.args },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-templates"] });
      setNewName("");
      setNewCommand("");
      setNewArgs("");
      setDialogOpen(false);
    },
  });

  const handleRegister = () => {
    const name = newName.trim();
    const command = newCommand.trim();
    if (!name || !command) return;
    const args = newArgs.trim() ? newArgs.trim().split(/\s+/).filter(Boolean) : [];
    registerMutation.mutate({ name, command, args });
  };

  return (
    <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto px-1">
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agent templates</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Register reusable agent templates and launch new managed agents.
          </p>
        </div>

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
                      Register a spawn configuration so you can quickly launch agents from it.
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
                  onStartAgent={() => createMutation.mutate(template.id)}
                  isStartingAgent={createMutation.isPending}
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
  onStartAgent,
  isStartingAgent,
}: {
  template: AgentTemplate;
  onStartAgent: () => void;
  isStartingAgent: boolean;
}) {
  return (
    <Card className="group transition-colors hover:border-foreground/20">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <TerminalIcon className="h-4 w-4" />
          </div>
          <CardTitle className="text-sm font-semibold">{template.name}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <code className="block truncate rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          {template.spawn.command} {(template.spawn.args ?? []).join(" ")}
        </code>
        <Button size="sm" className="w-full" onClick={onStartAgent} disabled={isStartingAgent}>
          <PlayIcon data-icon="inline-start" />
          Start agent
        </Button>
      </CardContent>
    </Card>
  );
}
