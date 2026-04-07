import { useState, useMemo, useEffect } from "react";
import {
  useRuntimeGitBranches,
  useRuntimeGitWorktrees,
  useCreateRuntimeGitWorktree,
} from "@flamecast/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  PlusIcon,
  LoaderCircleIcon,
  ChevronDownIcon,
  ArrowLeftIcon,
  SearchIcon,
} from "lucide-react";
import { toast } from "sonner";

type View = "list" | "create";

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
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("list");
  const [search, setSearch] = useState("");

  // Reset state when popover closes
  useEffect(() => {
    if (!open) {
      setView("list");
      setSearch("");
    }
  }, [open]);

  const worktreesQuery = useRuntimeGitWorktrees(instanceName, { path: gitPath });
  const worktrees = worktreesQuery.data?.worktrees ?? [];

  const filtered = useMemo(() => {
    if (!search) return worktrees;
    const lower = search.toLowerCase();
    return worktrees.filter(
      (wt) =>
        wt.branch?.toLowerCase().includes(lower) ||
        wt.path?.toLowerCase().includes(lower),
    );
  }, [worktrees, search]);

  const handleSelectWorktree = (path: string) => {
    onSelect(path);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1 rounded px-1 font-medium text-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-primary"
        >
          <GitBranchIcon className="inline size-3" />
          {activeBranch}
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        {view === "list" ? (
          <div className="flex flex-col">
            {/* Header with search */}
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                className="h-5 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                placeholder="Search worktrees..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
            </div>

            {/* Create new worktree */}
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
              onClick={() => setView("create")}
            >
              <PlusIcon className="size-3.5 shrink-0" />
              Create new worktree
            </button>

            <div className="h-px bg-border" />

            {/* Worktree list */}
            <div className="max-h-[240px] overflow-y-auto py-1">
              {worktreesQuery.isLoading ? (
                <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                  Loading...
                </div>
              ) : filtered.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No worktrees found
                </p>
              ) : (
                filtered.map((wt) => (
                  <button
                    key={wt.path}
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 overflow-hidden px-3 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                    onClick={() => handleSelectWorktree(wt.path)}
                  >
                    <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    {wt.branch ? (
                      <>
                        <span className="shrink-0 font-medium">{wt.branch}</span>
                        <span className="min-w-0 truncate text-muted-foreground" dir="rtl">{wt.path}</span>
                      </>
                    ) : (
                      <span className="min-w-0 truncate" dir="rtl">{wt.path}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <CreateWorktreeView
            instanceName={instanceName}
            gitPath={gitPath}
            onBack={() => setView("list")}
            onCreated={(path) => {
              onSelect(path);
              setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function CreateWorktreeView({
  instanceName,
  gitPath,
  onBack,
  onCreated,
}: {
  instanceName: string;
  gitPath: string;
  onBack: () => void;
  onCreated: (path: string) => void;
}) {
  const [worktreeName, setWorktreeName] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");

  const branchesQuery = useRuntimeGitBranches(instanceName, { path: gitPath });
  const allBranches = branchesQuery.data?.branches ?? [];

  const createWorktree = useCreateRuntimeGitWorktree(instanceName, {
    onSuccess: () => toast.success("Worktree created"),
  });

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
    <div className="flex flex-col">
      {/* Header with back button */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-3" />
        </button>
        <span className="text-xs font-medium">New worktree</span>
      </div>

      <div className="flex flex-col gap-2 p-3">
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] font-medium text-muted-foreground">Worktree name</Label>
          <Input
            placeholder="e.g. my-feature"
            value={worktreeName}
            onChange={(e) => setWorktreeName(e.target.value)}
            className="h-7 text-xs"
            autoFocus
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
