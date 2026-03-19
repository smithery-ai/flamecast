import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchConnections,
  createConnection,
  killConnection,
  fetchAgentProcesses,
  registerAgentProcess,
} from "@/client/lib/api";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card";
import { Badge } from "@/client/components/ui/badge";
import { Skeleton } from "@/client/components/ui/skeleton";
import { Input } from "@/client/components/ui/input";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/client/components/ui/combobox";
import { Trash2Icon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentProcessInfo } from "@/shared/connection";

export const Route = createFileRoute("/")({
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");

  const { data: processes = [], isLoading: processesLoading } = useQuery({
    queryKey: ["agent-processes"],
    queryFn: fetchAgentProcesses,
  });

  const { data: connections, isLoading: connectionsLoading } = useQuery({
    queryKey: ["connections"],
    queryFn: fetchConnections,
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (processes.length === 0) return;
    setSelectedProcessId((current) => {
      if (current != null && processes.some((p) => p.id === current)) return current;
      const first = processes[0];
      return first ? first.id : current;
    });
  }, [processes]);

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
    onSuccess: (row) => {
      queryClient.invalidateQueries({ queryKey: ["agent-processes"] });
      setSelectedProcessId(row.id);
      setNewLabel("");
      setNewCommand("");
      setNewArgs("");
    },
  });

  const killMutation = useMutation({
    mutationFn: (id: string) => killConnection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
    },
  });

  const handleRegister = () => {
    const label = newLabel.trim();
    const command = newCommand.trim();
    if (!label || !command) return;
    const args = newArgs.trim() ? newArgs.trim().split(/\s+/).filter(Boolean) : [];
    registerMutation.mutate({ label, command, args });
  };

  const selectedProcess: AgentProcessInfo | undefined = processes.find(
    (p) => p.id === selectedProcessId,
  );

  const isLoading = processesLoading || connectionsLoading;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Connections</h1>
          <p className="text-sm text-muted-foreground">Manage your agent connections</p>
        </div>
        <div className="flex w-full min-w-0 flex-col gap-3 sm:max-w-md">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <Combobox
                items={processes}
                value={selectedProcessId}
                onValueChange={(v) => setSelectedProcessId(v)}
                disabled={processesLoading || processes.length === 0}
                itemToStringLabel={(id) => processes.find((p) => p.id === id)?.label ?? id ?? ""}
              >
                <ComboboxInput
                  placeholder={
                    processes.length === 0 ? "No agent processes yet" : "Search processes…"
                  }
                  aria-label="Agent process"
                  disabled={processesLoading || processes.length === 0}
                />
                <ComboboxContent>
                  <ComboboxEmpty>No matching process</ComboboxEmpty>
                  <ComboboxList>
                    {(item: AgentProcessInfo) => (
                      <ComboboxItem
                        key={item.id}
                        value={item.id}
                        className="flex flex-col items-stretch gap-0.5 py-2"
                      >
                        <span className="truncate font-medium">{item.label}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {item.spawn.command} {(item.spawn.args ?? []).join(" ") || "(no args)"}
                        </span>
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </div>
            <Button
              className="shrink-0"
              onClick={() => selectedProcessId && createMutation.mutate(selectedProcessId)}
              disabled={createMutation.isPending || !selectedProcessId || processes.length === 0}
            >
              <PlusIcon data-icon="inline-start" />
              New connection
            </Button>
          </div>
          {selectedProcess && (
            <p className="text-xs text-muted-foreground">
              Spawns:{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[0.7rem]">
                {selectedProcess.spawn.command} {(selectedProcess.spawn.args ?? []).join(" ")}
              </code>
            </p>
          )}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Register agent process</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Save a spawn configuration so it appears in the combobox. Arguments are split on
            whitespace.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              placeholder="Label"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              aria-label="Process label"
            />
            <Input
              placeholder="Command (e.g. npx)"
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
              aria-label="Spawn command"
            />
            <Input
              placeholder="Args (space-separated)"
              value={newArgs}
              onChange={(e) => setNewArgs(e.target.value)}
              aria-label="Spawn arguments"
            />
          </div>
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleRegister}
              disabled={registerMutation.isPending || !newLabel.trim() || !newCommand.trim()}
            >
              Save process
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : connections?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-muted-foreground">
              No active connections. Create one to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {connections?.map((conn) => (
            <Card
              key={conn.id}
              className="cursor-pointer transition-colors hover:bg-muted/50"
              onClick={() =>
                navigate({
                  to: "/connections/$id",
                  params: { id: conn.id },
                })
              }
            >
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div className="flex min-w-0 items-center gap-3">
                  <CardTitle className="truncate text-base">Connection #{conn.id}</CardTitle>
                  <Badge variant="secondary" className="max-w-[12rem] shrink truncate">
                    {conn.agentLabel}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    killMutation.mutate(conn.id);
                  }}
                >
                  <Trash2Icon className="text-destructive" />
                </Button>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-1 text-sm text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-6">
                  <span>
                    Session: <code className="text-xs">{conn.sessionId.slice(0, 12)}…</code>
                  </span>
                  <span>{conn.logs.length} log entries</span>
                  <span>Started {new Date(conn.startedAt).toLocaleTimeString()}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
