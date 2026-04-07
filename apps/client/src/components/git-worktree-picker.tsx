import { useState, useEffect } from "react";
import {
  useRuntimeGitBranches,
  useRuntimeGitWorktrees,
  useCreateRuntimeGitWorktree,
} from "@flamecast/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  ChevronDownIcon,
} from "lucide-react";
import { toast } from "sonner";

/**
 * A dropdown menu on the branch name that lets the user:
 * 1. Create a new worktree (opens a form below)
 * 2. Use the chosen directory as-is
 * 3. Switch to an existing worktree
 */
export function GitWorktreeMenu({
  instanceName,
  gitPath,
  currentPath,
  activeBranch,
  onSelect,
}: {
  instanceName: string;
  gitPath: string;
  currentPath: string;
  activeBranch: string;
  onSelect: (absolutePath: string) => void;
}) {
  const [showCreateForm, setShowCreateForm] = useState(false);

  const worktreesQuery = useRuntimeGitWorktrees(instanceName, { path: gitPath });
  const worktrees = worktreesQuery.data?.worktrees ?? [];
  const otherWorktrees = worktrees.filter((wt) => wt.path !== gitPath);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 rounded px-1 font-medium text-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-primary"
          >
            <GitBranchIcon className="inline size-3" />
            {activeBranch}
            <ChevronDownIcon className="size-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          <DropdownMenuItem
            onSelect={() => setShowCreateForm(true)}
          >
            <PlusIcon className="size-3.5" />
            Create new worktree
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={() => {
              onSelect(currentPath);
              setShowCreateForm(false);
            }}
          >
            <FolderGit2Icon className="size-3.5" />
            Use chosen directory
          </DropdownMenuItem>

          {otherWorktrees.length > 0 && <DropdownMenuSeparator />}

          {otherWorktrees.map((wt) => (
            <DropdownMenuItem
              key={wt.path}
              onSelect={() => {
                onSelect(wt.path);
                setShowCreateForm(false);
              }}
            >
              <GitBranchIcon className="size-3.5" />
              <span className="truncate">
                {wt.branch ?? wt.path}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {showCreateForm && (
        <CreateWorktreeForm
          instanceName={instanceName}
          gitPath={gitPath}
          onCreated={(path) => {
            onSelect(path);
            setShowCreateForm(false);
          }}
          onCancel={() => setShowCreateForm(false)}
        />
      )}
    </>
  );
}

function CreateWorktreeForm({
  instanceName,
  gitPath,
  onCreated,
  onCancel,
}: {
  instanceName: string;
  gitPath: string;
  onCreated: (path: string) => void;
  onCancel: () => void;
}) {
  const [worktreeName, setWorktreeName] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");

  const branchesQuery = useRuntimeGitBranches(instanceName, { path: gitPath });
  const allBranches = branchesQuery.data?.branches ?? [];

  const createWorktree = useCreateRuntimeGitWorktree(instanceName, {
    onSuccess: () => toast.success("Worktree created"),
  });

  // Default to main/master once branches load
  useEffect(() => {
    if (!branchesQuery.data) return;
    const branches = branchesQuery.data.branches;
    const main = branches.find((b) => b.name === "main") ?? branches.find((b) => b.name === "master");
    if (main) setBaseBranch(main.name);
  }, [branchesQuery.data]);

  const handleCreate = () => {
    const name = worktreeName.trim();
    if (!name) {
      toast.error("Worktree name is required");
      return;
    }
    createWorktree.mutate(
      {
        path: gitPath,
        name,
        branch: name,
        newBranch: true,
        startPoint: baseBranch || undefined,
      },
      {
        onSuccess: (result) => onCreated(result.path),
        onError: (err) => toast.error("Failed to create worktree", { description: err.message }),
      },
    );
  };

  return (
    <div className="mt-3 rounded-md border p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <PlusIcon className="size-3.5" />
          New worktree
        </div>
        <button
          type="button"
          className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] font-medium text-muted-foreground">Worktree name</Label>
          <Input
            placeholder="e.g. my-feature"
            value={worktreeName}
            onChange={(e) => setWorktreeName(e.target.value)}
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
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={createWorktree.isPending}
            className="h-7 text-xs"
          >
            {createWorktree.isPending && (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            )}
            Create & select
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Returns the active branch name for the given git path.
 */
export function useActiveBranch(
  instanceName: string,
  gitPath: string | undefined,
  currentPath: string,
) {
  const worktreesQuery = useRuntimeGitWorktrees(instanceName, {
    enabled: !!gitPath,
    path: gitPath,
  });
  const worktrees = worktreesQuery.data?.worktrees ?? [];
  const currentWorktree = worktrees.find((wt) => wt.path === currentPath);
  const mainWorktree = worktrees.find((wt) => wt.path === gitPath);
  return currentWorktree?.branch ?? mainWorktree?.branch ?? null;
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
