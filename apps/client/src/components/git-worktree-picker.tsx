import { useState } from "react";
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
  GitBranchIcon,
  FolderGit2Icon,
  PlusIcon,
  LoaderCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
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
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<WorktreeSelection>({ kind: "current" });
  const [newBranchName, setNewBranchName] = useState("");
  const [newWorktreeName, setNewWorktreeName] = useState("");

  const worktreesQuery = useRuntimeGitWorktrees(instanceName, {
    enabled: expanded,
    path: gitPath,
  });
  const branchesQuery = useRuntimeGitBranches(instanceName, {
    enabled: expanded && selection.kind === "new",
    path: gitPath,
  });

  const createWorktree = useCreateRuntimeGitWorktree(instanceName, {
    onSuccess: () => {
      toast.success("Worktree created");
    },
  });

  const worktrees = worktreesQuery.data?.worktrees ?? [];
  // Exclude the main worktree (same as gitPath) from the list
  const otherWorktrees = worktrees.filter((wt) => wt.path !== gitPath);

  const handleApply = () => {
    if (selection.kind === "current") {
      onSelect(currentPath);
    } else if (selection.kind === "worktree") {
      onSelect(selection.path);
    } else if (selection.kind === "new") {
      if (!newWorktreeName.trim()) {
        toast.error("Worktree name is required");
        return;
      }
      createWorktree.mutate(
        {
          path: gitPath,
          name: newWorktreeName.trim(),
          branch: newBranchName.trim() || undefined,
        },
        {
          onSuccess: (result) => {
            onSelect(result.path);
            setExpanded(false);
          },
          onError: (err) => toast.error("Failed to create worktree", { description: err.message }),
        },
      );
    }
  };

  if (!expanded) {
    return (
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        onClick={() => setExpanded(true)}
      >
        <GitBranchIcon className="size-3.5" />
        <span>Git repository detected</span>
        <span className="ml-auto flex items-center gap-0.5 text-[10px]">
          Branch / worktree options
          <ChevronDownIcon className="size-3" />
        </span>
      </button>
    );
  }

  return (
    <div className="rounded-md border p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <GitBranchIcon className="size-3.5" />
          Git worktree
        </div>
        <button
          type="button"
          className="flex cursor-pointer items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(false)}
        >
          Collapse
          <ChevronUpIcon className="size-3" />
        </button>
      </div>

      {worktreesQuery.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Loading worktrees...
        </div>
      ) : (
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
          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/50">
            <RadioGroupItem value="current" />
            <FolderGit2Icon className="size-3.5 text-muted-foreground" />
            <span>
              Current directory
              <span className="ml-1 text-muted-foreground">({currentPath})</span>
            </span>
          </label>

          {/* Existing worktrees */}
          {otherWorktrees.map((wt) => (
            <label
              key={wt.path}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/50"
            >
              <RadioGroupItem value={`wt:${wt.path}`} />
              <GitBranchIcon className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 truncate">{wt.path}</span>
              {wt.branch && (
                <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {wt.branch}
                </span>
              )}
            </label>
          ))}

          {/* Create new worktree option */}
          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/50">
            <RadioGroupItem value="new" />
            <PlusIcon className="size-3.5 text-muted-foreground" />
            <span>Create new worktree</span>
          </label>
        </RadioGroup>
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
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] font-medium text-muted-foreground">
              Branch name <span className="text-muted-foreground/60">(optional — defaults to worktree name)</span>
            </Label>
            <Input
              placeholder="e.g. feature/my-feature"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              className="h-7 text-xs"
              list="git-branches"
            />
            {branchesQuery.data && (
              <datalist id="git-branches">
                {branchesQuery.data.branches.map((b) => (
                  <option key={b.name} value={b.name} />
                ))}
              </datalist>
            )}
          </div>
        </div>
      )}

      {/* Apply button */}
      {(selection.kind !== "current" || expanded) && (
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            variant={selection.kind === "current" ? "outline" : "default"}
            onClick={handleApply}
            disabled={createWorktree.isPending}
            className="h-7 text-xs"
          >
            {createWorktree.isPending && (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            )}
            {selection.kind === "new"
              ? "Create & select"
              : selection.kind === "worktree"
                ? "Use this worktree"
                : "Use current directory"}
          </Button>
        </div>
      )}
    </div>
  );
}
