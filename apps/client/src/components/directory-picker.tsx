import { useState, useCallback } from "react";
import { useRuntimeFileSystem } from "@flamecast/ui";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  ArrowUpIcon,
  FolderIcon,
  GitBranchIcon,
  HomeIcon,
  CheckIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { GitBadges } from "@/components/git-badges";

export function DirectoryPicker({
  instanceName,
  open,
  onOpenChange,
  onSelect,
  initialPath,
}: {
  instanceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (absolutePath: string) => void;
  initialPath?: string;
}) {
  const [currentPath, setCurrentPath] = useState<string | undefined>(initialPath);
  const [showAllFiles, setShowAllFiles] = useState(false);

  const fsQuery = useRuntimeFileSystem(instanceName, {
    enabled: open,
    showAllFiles,
    path: currentPath,
  });

  const workspaceRoot = fsQuery.data?.root ?? "/";
  const displayPath = fsQuery.data?.path ?? currentPath ?? workspaceRoot;

  type Entry = NonNullable<typeof fsQuery.data>["entries"][number];

  const directories = (fsQuery.data?.entries ?? ([] as Entry[]))
    .filter((e: Entry) => isDirType(e.type))
    .sort((a: Entry, b: Entry) => a.path.localeCompare(b.path));

  const isAtRoot = displayPath === workspaceRoot;
  const parentPath = displayPath.replace(/\/[^/]+$/, "") || "/";

  const handleNavigate = useCallback((absolutePath: string) => {
    setCurrentPath(absolutePath);
  }, []);

  const handleSelect = useCallback(() => {
    onSelect(displayPath);
    onOpenChange(false);
  }, [displayPath, onSelect, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Select directory</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">
            {displayPath}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[400px] min-h-[200px] flex-col overflow-hidden rounded-md border">
          {/* Navigation bar */}
          <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
            {!isAtRoot && (
              <>
                <button
                  className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  onClick={() => handleNavigate(parentPath)}
                  title="Go to parent directory"
                  type="button"
                >
                  <ArrowUpIcon className="size-3" />
                  <span>Up</span>
                </button>
                <button
                  className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  onClick={() => setCurrentPath(undefined)}
                  title="Go to home directory"
                  type="button"
                >
                  <HomeIcon className="size-3" />
                  <span>Home</span>
                </button>
              </>
            )}
            <label className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
              <span>All</span>
              <Switch
                aria-label="Show hidden and ignored files"
                checked={showAllFiles}
                onCheckedChange={setShowAllFiles}
                size="sm"
              />
            </label>
          </div>

          {/* Directory list */}
          <div className="flex-1 overflow-auto p-1.5">
            {fsQuery.isLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                <LoaderCircleIcon className="size-3.5 animate-spin" />
                Loading...
              </div>
            ) : directories.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                No subdirectories found.
              </p>
            ) : (
              <div className="font-mono text-xs" role="list">
                {directories.map((entry: Entry) => {
                  const absolutePath =
                    displayPath === "/" ? `/${entry.path}` : `${displayPath}/${entry.path}`;
                  return (
                    <button
                      key={entry.path}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-1.5 rounded border-none bg-transparent px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50",
                        entry.path.startsWith(".") && "opacity-50",
                      )}
                      onClick={() => handleNavigate(absolutePath)}
                      role="listitem"
                      tabIndex={0}
                      type="button"
                    >
                      {entry.git ? (
                        <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <FolderIcon className="size-4 shrink-0 text-blue-500" />
                      )}
                      <span className="shrink-0">{entry.path}</span>
                      {entry.git && (
                        <GitBadges branch={entry.git.branch} origin={entry.git.origin} />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSelect}>
            <CheckIcon data-icon="inline-start" />
            Select this directory
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isDirType(type: string): boolean {
  return type === "directory" || type === "symlink";
}
