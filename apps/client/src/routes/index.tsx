import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRuntimes, useAgentTemplates, useCreateSession } from "@flamecast/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SendIcon } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();
  const { data: runtimes } = useRuntimes();
  const { data: templates } = useAgentTemplates();

  const defaultRuntime = runtimes?.[0]?.typeName ?? "";
  const [selectedRuntime, setSelectedRuntime] = useState<string>("");
  const activeRuntime = selectedRuntime || defaultRuntime;

  // Find the first agent template that matches the selected runtime
  const defaultTemplate =
    templates?.find((t) => t.runtime.provider === activeRuntime) ?? templates?.[0];

  const [prompt, setPrompt] = useState("");

  const createMutation = useCreateSession({
    onSuccess: (session) =>
      navigate({
        to: "/sessions/$id",
        params: { id: session.id },
        search: { prompt: prompt.trim() },
      }),
    onError: (err) => toast.error("Failed to create session", { description: String(err.message) }),
  });

  const handleSend = () => {
    if (!prompt.trim() || !defaultTemplate) return;

    // Determine runtime instance for multi-instance runtimes
    const runtimeInfo = runtimes?.find((rt) => rt.typeName === activeRuntime);
    const runtimeInstance =
      runtimeInfo && !runtimeInfo.onlyOne
        ? runtimeInfo.instances.find((i) => i.status === "running")?.name
        : undefined;

    createMutation.mutate({
      agentTemplateId: defaultTemplate.id,
      runtimeInstance,
    });
  };

  const canSend = prompt.trim() && defaultTemplate && !createMutation.isPending;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8 px-1">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">Flamecast</h1>
        <p className="mt-2 text-sm text-muted-foreground">What would you like to work on?</p>
      </div>

      <div className="flex w-full flex-col gap-3">
        <div className="flex gap-2">
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canSend && handleSend()}
            placeholder="Send a prompt to the agent..."
            disabled={createMutation.isPending}
            className="flex-1"
          />
          <Button onClick={handleSend} disabled={!canSend}>
            <SendIcon data-icon="inline-start" />
            {createMutation.isPending ? "Starting…" : "Send"}
          </Button>
        </div>

        <div className="flex items-center gap-3">
          {runtimes && runtimes.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Runtime</span>
              <Select value={activeRuntime} onValueChange={setSelectedRuntime}>
                <SelectTrigger className="h-8 w-auto min-w-[120px] text-xs">
                  <SelectValue />
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

          {defaultTemplate && (
            <span className="text-xs text-muted-foreground">
              Agent: <span className="font-medium text-foreground">{defaultTemplate.name}</span>
            </span>
          )}

          {!defaultTemplate && templates !== undefined && (
            <span className="text-xs text-muted-foreground">
              No agents registered.{" "}
              <a href="/agents" className="underline underline-offset-2 hover:text-foreground">
                Create one
              </a>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
