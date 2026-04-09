import { createFileRoute } from "@tanstack/react-router";
import {
  useAgentTemplates,
  useRuntimes,
  useRuntimeFileSystem,
  useFlamecastClient,
} from "@flamecast/ui";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useBackendUrl } from "@/lib/backend-url-context";
import { useDefaultAgentConfig } from "@/lib/default-agent-config-context";
import { DirectoryPicker } from "@/components/directory-picker";
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
import { Switch } from "@/components/ui/switch";
import {
  CheckIcon,
  FolderOpenIcon,
  GitBranchIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto px-1">
      <div className="flex flex-col gap-8 py-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure your Flamecast environment and default agent settings.
          </p>
        </div>

        <BackendUrlSection />
        <PermissionsSection />
        <DefaultAgentConfigSection />
      </div>
    </div>
  );
}

// ─── Backend URL ──────────────────────────────────────────────────────────────

function BackendUrlSection() {
  const { backendUrl, defaultUrl, setBackendUrl, resetBackendUrl } = useBackendUrl();
  const [draft, setDraft] = useState(backendUrl);

  const isCustom = backendUrl !== defaultUrl;
  const isDirty = draft !== backendUrl;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Backend URL</CardTitle>
        <CardDescription>
          The server URL that Flamecast connects to. Default: {defaultUrl}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const url = draft.trim();
            if (url) {
              setBackendUrl(url);
              toast.success("Backend URL updated");
            }
          }}
        >
          <Input
            type="url"
            placeholder={defaultUrl}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" variant="outline" size="icon" disabled={!isDirty || !draft.trim()}>
            <CheckIcon className="size-4" />
          </Button>
          {isCustom && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              title="Reset to default"
              onClick={() => {
                resetBackendUrl();
                setDraft(defaultUrl);
                toast.success("Backend URL reset to default");
              }}
            >
              <RotateCcwIcon className="size-4" />
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// ─── Permissions ──────────────────────────────────────────────────────────────

function PermissionsSection() {
  const client = useFlamecastClient();
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => client.fetchSettings(),
  });

  const mutation = useMutation({
    mutationFn: (patch: { autoApprovePermissions: boolean }) => client.updateSettings(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(["settings"], updated);
    },
    onError: (err) => toast.error("Failed to update setting", { description: String(err.message) }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Permissions</CardTitle>
        <CardDescription>
          Control how agent permission requests are handled server-side.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between rounded-lg border px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <ShieldCheckIcon className="size-4 text-muted-foreground" />
              <Label htmlFor="auto-approve" className="text-sm font-medium">
                Auto-approve permissions
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Automatically approve all agent permission requests (file edits, command execution,
              etc.) without prompting. Use with caution.
            </p>
          </div>
          <Switch
            id="auto-approve"
            checked={settings?.autoApprovePermissions ?? false}
            disabled={mutation.isPending}
            onCheckedChange={(checked) => mutation.mutate({ autoApprovePermissions: !!checked })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Default Agent Configuration ──────────────────────────────────────────────

function DefaultAgentConfigSection() {
  const { config, updateConfig } = useDefaultAgentConfig();
  const { data: templates } = useAgentTemplates();
  const { data: runtimes } = useRuntimes();

  // Resolve a runtime instance for the directory picker
  const firstRunningInstance =
    runtimes?.flatMap((rt) => rt.instances).find((i) => i.status === "running")?.name ??
    runtimes?.[0]?.typeName ??
    "default";

  // Fetch the runtime's home directory as the default
  const { data: homeFsData } = useRuntimeFileSystem(firstRunningInstance);
  const runtimeHomeDir = homeFsData?.root ?? "";

  // Effective values: use config if set, otherwise computed defaults
  const effectiveTemplateId = config.agentTemplateId || templates?.[0]?.id || "";
  const effectiveDirectory = config.defaultDirectory || runtimeHomeDir;

  // Directory picker state
  const [dirPickerOpen, setDirPickerOpen] = useState(false);

  // Git detection for the effective directory
  const { data: cwdFsData } = useRuntimeFileSystem(firstRunningInstance, {
    enabled: !!effectiveDirectory,
    path: effectiveDirectory || undefined,
  });
  const isGitDirectory = !!cwdFsData?.gitPath;

  // Find the selected template for display
  const selectedTemplate = templates?.find((t) => t.id === effectiveTemplateId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New Agent Default Configuration</CardTitle>
        <CardDescription>
          Defaults used when spawning agents via email, Slack, or other integrations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          {/* Agent Template */}
          <div className="flex flex-col gap-2">
            <Label>Agent Template</Label>
            <Select
              value={effectiveTemplateId}
              onValueChange={(value) => updateConfig({ agentTemplateId: value })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a template..." />
              </SelectTrigger>
              <SelectContent>
                {templates?.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                    {t.runtime.provider && t.runtime.provider !== "default" && (
                      <span className="ml-1 text-muted-foreground">({t.runtime.provider})</span>
                    )}
                  </SelectItem>
                ))}
                {(!templates || templates.length === 0) && (
                  <SelectItem value="__none" disabled>
                    No templates registered
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {selectedTemplate && (
              <p className="text-xs text-muted-foreground">
                <code>
                  {selectedTemplate.spawn.command} {(selectedTemplate.spawn.args ?? []).join(" ")}
                </code>
              </p>
            )}
          </div>

          {/* Default Directory */}
          <div className="flex flex-col gap-2">
            <Label>Default Directory</Label>
            <div className="flex items-center gap-2">
              <Input
                value={effectiveDirectory}
                onChange={(e) =>
                  updateConfig({ defaultDirectory: e.target.value, createWorktree: false })
                }
                placeholder={runtimeHomeDir || "/home/user"}
                className="flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setDirPickerOpen(true)}
                title="Browse directories"
              >
                <FolderOpenIcon className="size-4" />
              </Button>
            </div>
            <DirectoryPicker
              instanceName={firstRunningInstance}
              open={dirPickerOpen}
              onOpenChange={setDirPickerOpen}
              onSelect={(path) => updateConfig({ defaultDirectory: path, createWorktree: false })}
              initialPath={effectiveDirectory || undefined}
            />
          </div>

          {/* Git Worktree Option */}
          {isGitDirectory && (
            <div className="flex items-center justify-between rounded-lg border px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <GitBranchIcon className="size-4 text-muted-foreground" />
                  <Label htmlFor="create-worktree" className="text-sm font-medium">
                    Create worktree on spawn
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Automatically create a git worktree with a random name when spawning a new agent
                  session.
                </p>
              </div>
              <Switch
                id="create-worktree"
                checked={config.createWorktree}
                onCheckedChange={(checked) => updateConfig({ createWorktree: !!checked })}
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
