import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createAgent } from "@/client/lib/api";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card";
import { PlayIcon, TerminalIcon } from "lucide-react";
import type { AgentSpawn, RuntimeConfig } from "@/shared/session";

export const Route = createFileRoute("/")({
  component: AgentsPage,
});

type AgentExample = {
  id: string;
  name: string;
  spawn: AgentSpawn;
  runtime: RuntimeConfig;
};

const STATIC_AGENT_EXAMPLES: AgentExample[] = [
  {
    id: "example",
    name: "Example agent",
    spawn: { command: "npx", args: ["tsx", "src/flamecast/agent.ts"] },
    runtime: { provider: "local" },
  },
  {
    id: "codex",
    name: "Codex ACP",
    spawn: { command: "npx", args: ["@zed-industries/codex-acp"] },
    runtime: { provider: "local" },
  },
  {
    id: "example-docker",
    name: "Example agent (Docker)",
    spawn: { command: "npx", args: ["tsx", "agent.ts"] },
    runtime: {
      provider: "docker",
      image: "flamecast/example-agent",
      dockerfile: "docker/example-agent.Dockerfile",
    },
  },
];

function AgentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async (example: AgentExample) => {
      const agent = await createAgent({
        name: example.name,
        spawn: example.spawn,
        runtime: example.runtime,
        initialSessionCwd: ".",
      });
      if (!agent.latestSessionId) {
        throw new Error("Agent started without an initial session");
      }
      return { agent, sessionId: agent.latestSessionId };
    },
    onSuccess: ({ agent, sessionId }) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate({
        to: "/agents/$agentId/sessions/$sessionId",
        params: { agentId: agent.id, sessionId },
      });
    },
  });

  return (
    <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto px-1">
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agent examples</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Launch a managed agent from a few built-in example configurations.
          </p>
          {createMutation.error ? (
            <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : "Failed to start agent session"}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Built-in examples
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {STATIC_AGENT_EXAMPLES.map((example) => (
              <AgentExampleCard
                key={example.id}
                example={example}
                onStartAgent={() => createMutation.mutate(example)}
                isStartingAgent={createMutation.isPending}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentExampleCard({
  example,
  onStartAgent,
  isStartingAgent,
}: {
  example: AgentExample;
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
          <CardTitle className="text-sm font-semibold">{example.name}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <code className="block truncate rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          {example.spawn.command} {(example.spawn.args ?? []).join(" ")}
        </code>
        <Button size="sm" className="w-full" onClick={onStartAgent} disabled={isStartingAgent}>
          <PlayIcon data-icon="inline-start" />
          Start agent
        </Button>
      </CardContent>
    </Card>
  );
}
