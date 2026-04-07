import { useState, useMemo } from "react";
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
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState(false);

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

  // Filter out branches that already have a worktree
  const worktreeBranches = new Set(worktrees.map((wt) => wt.branch).filter(Boolean));
  const availableBranches = useMemo(
    () => (branchesQuery.data?.branches ?? []).filter((b) => !worktreeBranches.has(b.name)),
    [branchesQuery.data, worktreeBranches],
  );

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
          branch: selectedBranch || newWorktreeName.trim(),
          newBranch,
        },
        {
          onSuccess: (result) => {
            onSelect(result.path);
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
                <span className="min-w-0 truncate" dir="rtl">{wt.path}</span>
                {wt.branch && (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {wt.branch}
                  </span>
                )}
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
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] font-medium text-muted-foreground">Branch</Label>
            <BranchCombobox
              branches={availableBranches}
              isLoading={branchesQuery.isLoading}
              value={selectedBranch}
              onChange={(value, isNew) => {
                setSelectedBranch(value);
                setNewBranch(isNew);
              }}
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
  branches: Array<{ name: string; sha: string; current: boolean }>;
  isLoading: boolean;
  value: string | null;
  onChange: (value: string | null, isNew: boolean) => void;
}) {
  const [inputValue, setInputValue] = useState("");

  const filtered = useMemo(() => {
    if (!inputValue) return branches;
    const lower = inputValue.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(lower));
  }, [branches, inputValue]);

  const exactMatch = branches.some((b) => b.name === inputValue);

  return (
    <Combobox
      value={value}
      onValueChange={(val) => {
        const branch = typeof val === "string" ? val : null;
        onChange(branch, false);
      }}
    >
      <ComboboxInput
        placeholder={isLoading ? "Loading branches..." : "Search or type a new branch name..."}
        disabled={isLoading}
        className="h-7 text-xs"
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
        }}
      />
      <ComboboxContent>
        <ComboboxList>
          {/* Existing branches */}
          {filtered.map((b) => (
            <ComboboxItem key={b.name} value={b.name} className="text-xs">
              <GitBranchIcon className="size-3 text-muted-foreground" />
              {b.name}
              {b.current && (
                <span className="ml-auto text-[10px] text-muted-foreground">current</span>
              )}
            </ComboboxItem>
          ))}
          {/* Create new branch option when input doesn't match */}
          {inputValue && !exactMatch && (
            <ComboboxItem
              value={inputValue}
              className="text-xs"
              onSelect={() => {
                onChange(inputValue, true);
              }}
            >
              <PlusIcon className="size-3 text-muted-foreground" />
              Create branch &ldquo;{inputValue}&rdquo;
            </ComboboxItem>
          )}
          <ComboboxEmpty>No branches found</ComboboxEmpty>
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
