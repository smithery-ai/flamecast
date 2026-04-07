import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  ArrowUpIcon,
  FileIcon,
  FolderIcon,
  FolderTreeIcon,
  GitBranchIcon,
  HomeIcon,
} from "lucide-react";
import { GitBadges } from "@/components/git-badges";
import type { FileSystemEntry } from "@flamecast/sdk/session";

export function RuntimeFileTree({
  workspaceRoot,
  currentPath,
  entries,
  showAllFiles,
  onShowAllFilesChange,
  onFileSelect,
  onNavigate,
  emptyTreeMessage = "No filesystem entries returned.",
}: {
  /** The workspace root (absolute path). */
  workspaceRoot: string;
  /** The absolute path of the directory currently being shown. */
  currentPath: string;
  /** Direct children of `currentPath` — names only, not full paths. */
  entries: FileSystemEntry[];
  showAllFiles: boolean;
  onShowAllFilesChange: (showAllFiles: boolean) => void;
  onFileSelect: (path: string) => void;
  /** Called when the user navigates to a different directory (absolute path). */
  onNavigate: (absolutePath: string) => void;
  emptyTreeMessage?: string;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const isAtRoot = currentPath === workspaceRoot;
  const parentPath = currentPath.replace(/\/[^/]+$/, "") || "/";
  // Clamp "Up" to the workspace root — don't navigate above it
  const canGoUp = !isAtRoot;

  // Sort: directories first, then alphabetically
  const sorted = [...entries].sort((a, b) => {
    const aDir = isDirType(a.type);
    const bDir = isDirType(b.type);
    if (aDir && !bDir) return -1;
    if (!aDir && bDir) return 1;
    return a.path.localeCompare(b.path);
  });

  const handleSelect = (entry: FileSystemEntry) => {
    const absolutePath = currentPath === "/" ? `/${entry.path}` : `${currentPath}/${entry.path}`;
    if (isDirType(entry.type)) {
      onNavigate(absolutePath);
    } else {
      setSelectedPath(absolutePath);
      // Strip workspace root prefix to get a workspace-relative path
      const wsPrefix = workspaceRoot.endsWith("/") ? workspaceRoot : workspaceRoot + "/";
      const relativePath = absolutePath.startsWith(wsPrefix)
        ? absolutePath.slice(wsPrefix.length)
        : entry.path;
      onFileSelect(relativePath);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <FolderTreeIcon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{currentPath}</span>
        <label className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>All</span>
          <Switch
            aria-label="Show ignored files"
            checked={showAllFiles}
            onCheckedChange={onShowAllFilesChange}
            size="sm"
          />
        </label>
      </div>
      {canGoUp && (
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <button
            className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            onClick={() => onNavigate(parentPath)}
            title="Go to parent directory"
            type="button"
          >
            <ArrowUpIcon className="size-3" />
            <span>Up</span>
          </button>
          <button
            className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            onClick={() => onNavigate(workspaceRoot)}
            title="Go to home directory"
            type="button"
          >
            <HomeIcon className="size-3" />
            <span>Home</span>
          </button>
        </div>
      )}
      <div className="h-0 min-h-0 flex-1 overflow-auto p-1.5">
        {sorted.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {entries.length === 0 ? emptyTreeMessage : "Empty directory."}
          </p>
        ) : (
          <div className="font-mono text-xs" role="list">
            {sorted.map((entry) => {
              const absolutePath =
                currentPath === "/" ? `/${entry.path}` : `${currentPath}/${entry.path}`;
              return (
                <button
                  key={entry.path}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-1.5 rounded border-none bg-transparent px-2 py-1 text-left text-xs transition-colors hover:bg-muted/50",
                    selectedPath === absolutePath && "bg-muted",
                    entry.path.startsWith(".") && "opacity-50",
                  )}
                  onClick={() => handleSelect(entry)}
                  role="listitem"
                  tabIndex={0}
                  type="button"
                >
                  {isDirType(entry.type) ? (
                    entry.git ? (
                      <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FolderIcon className="size-4 shrink-0 text-blue-500" />
                    )
                  ) : (
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className={entry.git ? "shrink-0" : "truncate"}>{entry.path}</span>
                  {entry.git && <GitBadges branch={entry.git.branch} origin={entry.git.origin} />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function isDirType(type: FileSystemEntry["type"]): boolean {
  return type === "directory" || type === "symlink";
}
