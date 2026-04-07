import { useState, useMemo, useEffect } from "react";
import {
  useRuntimeGitBranches,
  useRuntimeGitWorktrees,
  useCreateRuntimeGitWorktree,
} from "@flamecast/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/components/ui/combobox";
import {
  GitBranchIcon,
  FolderGit2Icon,
  PlusIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { toast } from "sonner";

type WorktreeSelection =
  | { kind: "current" }
  | { kind: "worktree"; path: string }
  | { kind: "new" };

export function GitWorktreePicker({
  instanceName,
  gitPath,
  currentPath,
  onSelect,
}: {
  instanceName: string;
  /** Absolute path to the git root directory. */
  gitPath: string;
  /** The currently selected working directory. */
  currentPath: string;
  /** Called when the user picks a directory — may be the same as currentPath. */
  onSelect: (absolutePath: string) => void;
}) {
  const [selection, setSelection] = useState<WorktreeSelection>({ kind: "current" });
  const [newWorktreeName, setNewWorktreeName] = useState("");
  const [baseBranch, setBaseBranch] = useState<string>("main");

  // Always fetch worktrees and branches immediately
  const worktreesQuery = useRuntimeGitWorktrees(instanceName, { path: gitPath });
  const branchesQuery = useRuntimeGitBranches(instanceName, { path: gitPath });

  const createWorktree = useCreateRuntimeGitWorktree(instanceName, {
    onSuccess: () => {
      toast.success("Worktree created");
    },
  });

  const worktrees = worktreesQuery.data?.worktrees ?? [];
  const otherWorktrees = worktrees.filter((wt) => wt.path !== gitPath);
  const allBranches = branchesQuery.data?.branches ?? [];

  // Default to main/master once branches load
  useEffect(() => {
    if (!branchesQuery.data) return;
    const branches = branchesQuery.data.branches;
    const main = branches.find((b) => b.name === "main") ?? branches.find((b) => b.name === "master");
    if (main) {
      setBaseBranch(main.name);
    }
  }, [branchesQuery.data]);

  const handleApply = () => {
    if (selection.kind === "current") {
      onSelect(currentPath);
    } else if (selection.kind === "worktree") {
      onSelect(selection.path);
    } else if (selection.kind === "new") {
      const name = newWorktreeName.trim();
      if (!name) {
        toast.error("Worktree name is required");
        return;
      }
      // git worktree add ../name -b name baseBranch
      // Creates a new branch `name` starting from `baseBranch`
      createWorktree.mutate(
        {
          path: gitPath,
          name,
          branch: name,
          newBranch: true,
          startPoint: baseBranch || undefined,
        },
        {
          onSuccess: (result) => {
            setSelection({ kind: "worktree", path: result.path });
            setNewWorktreeName("");
          },
          onError: (err) => toast.error("Failed to create worktree", { description: err.message }),
        },
      );
    }
  };

  return (
    <div className="rounded-md border p-3">
      <div className="mb-3 flex items-center gap-1.5 text-xs font-medium">
        <GitBranchIcon className="size-3.5" />
        Git worktree
      </div>

      {worktreesQuery.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Loading worktrees...
        </div>
      ) : (
        <div className="max-h-[240px] overflow-y-auto">
          <RadioGroup
            value={
              selection.kind === "current"
                ? "current"
                : selection.kind === "worktree"
                  ? `wt:${selection.path}`
                  : "new"
            }
            onValueChange={(value) => {
              if (value === "current") {
                setSelection({ kind: "current" });
              } else if (value === "new") {
                setSelection({ kind: "new" });
              } else if (value.startsWith("wt:")) {
                setSelection({ kind: "worktree", path: value.slice(3) });
              }
            }}
          >
            {/* Current directory option */}
            <label className="flex cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/50">
              <RadioGroupItem value="current" />
              <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0">Current directory</span>
              <span className="min-w-0 truncate text-muted-foreground" dir="rtl">({currentPath})</span>
            </label>

            {/* Existing worktrees */}
            {otherWorktrees.map((wt) => (
              <label
                key={wt.path}
                className="flex cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/50"
              >
                <RadioGroupItem value={`wt:${wt.path}`} />
                <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                {wt.branch && (
                  <span className="shrink-0 font-medium">{wt.branch}</span>
                )}
                <span className="min-w-0 truncate text-muted-foreground" dir="rtl">{wt.path}</span>
              </label>
            ))}

            {/* Create new worktree option */}
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/50">
              <RadioGroupItem value="new" />
              <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span>Create new worktree</span>
            </label>
          </RadioGroup>
        </div>
      )}

      {/* New worktree form */}
      {selection.kind === "new" && (
        <div className="mt-3 flex flex-col gap-2 border-t pt-3">
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] font-medium text-muted-foreground">Worktree name</Label>
            <Input
              placeholder="e.g. my-feature"
              value={newWorktreeName}
              onChange={(e) => setNewWorktreeName(e.target.value)}
              className="h-7 text-xs"
            />
            <p className="text-[10px] text-muted-foreground/60">
              Also used as the new branch name
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] font-medium text-muted-foreground">Branch off of:</Label>
            <BranchCombobox
              branches={allBranches}
              isLoading={branchesQuery.isLoading}
              value={baseBranch}
              onChange={setBaseBranch}
            />
          </div>
        </div>
      )}

      {/* Apply button */}
      {selection.kind !== "current" && (
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            onClick={handleApply}
            disabled={createWorktree.isPending}
            className="h-7 text-xs"
          >
            {createWorktree.isPending && (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            )}
            {selection.kind === "new" ? "Create & select" : "Use this worktree"}
          </Button>
        </div>
      )}
    </div>
  );
}

function BranchCombobox({
  branches,
  isLoading,
  value,
  onChange,
}: {
  branches: Array<{ name: string; sha: string; current: boolean; remote?: boolean }>;
  isLoading: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Combobox
      value={value}
      onValueChange={(val) => {
        if (val != null) {
          onChange(String(val));
        }
      }}
    >
      <ComboboxInput
        placeholder={isLoading ? "Loading branches..." : "Search branches..."}
        disabled={isLoading}
        className="h-7 text-xs"
        showClear={false}
      />
      <ComboboxContent>
        <ComboboxList>
          {branches.map((b) => (
            <ComboboxItem key={b.name} value={b.name} className="text-xs">
              <GitBranchIcon className="size-3 text-muted-foreground" />
              {b.name}
              {b.current && (
                <span className="ml-auto text-[10px] text-muted-foreground">current</span>
              )}
            </ComboboxItem>
          ))}
          <ComboboxEmpty>
            No branches found
          </ComboboxEmpty>
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
