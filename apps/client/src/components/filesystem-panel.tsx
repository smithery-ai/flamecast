import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  ArrowUpIcon,
  FileCode2Icon,
  FileIcon,
  FolderIcon,
  FolderTreeIcon,
  HomeIcon,
} from "lucide-react";
import type { FileSystemEntry } from "@flamecast/sdk/session";

export function FileSystemPanel({
  workspaceRoot,
  currentPath,
  entries,
  showAllFiles,
  onShowAllFilesChange,
  loadPreview,
  onNavigate,
  emptyTreeMessage = "No filesystem entries returned.",
}: {
  /** The workspace root (absolute path). */
  workspaceRoot: string;
  /** The absolute path of the directory currently being shown. */
  currentPath: string;
  /** Direct children of `currentPath` — names only. */
  entries: FileSystemEntry[];
  showAllFiles: boolean;
  onShowAllFilesChange: (showAllFiles: boolean) => void;
  loadPreview: (path: string) => Promise<{ content: string; truncated: boolean }>;
  /** Called when the user navigates to a different directory (absolute path). */
  onNavigate: (absolutePath: string) => void;
  emptyTreeMessage?: string;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<{ content: string; truncated: boolean } | null>(
    null,
  );
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);

  const isAtRoot = currentPath === workspaceRoot;
  const parentPath = currentPath.replace(/\/[^/]+$/, "") || "/";
  const canGoUp = !isAtRoot;

  // Sort: directories first, then alphabetically
  const sorted = [...entries].sort((a, b) => {
    const aDir = isDirType(a.type);
    const bDir = isDirType(b.type);
    if (aDir && !bDir) return -1;
    if (!aDir && bDir) return 1;
    return a.path.localeCompare(b.path);
  });

  // Auto-select first file when entries change and nothing valid is selected
  useEffect(() => {
    if (selectedPath) {
      const stillExists = entries.some(
        (e) => !isDirType(e.type) && toAbsolute(currentPath, e.path) === selectedPath,
      );
      if (stillExists) return;
    }
    const firstFile = entries.find((e) => !isDirType(e.type));
    setSelectedPath(firstFile ? toAbsolute(currentPath, firstFile.path) : null);
  }, [entries, currentPath, selectedPath]);

  // Load preview when selected file changes
  useEffect(() => {
    if (!selectedPath) {
      setFilePreview(null);
      return;
    }

    const wsPrefix = workspaceRoot.endsWith("/") ? workspaceRoot : workspaceRoot + "/";
    const relativePath = selectedPath.startsWith(wsPrefix)
      ? selectedPath.slice(wsPrefix.length)
      : selectedPath;

    let cancelled = false;
    setFilePreviewLoading(true);
    loadPreview(relativePath)
      .then((result) => {
        if (!cancelled) {
          setFilePreview({ content: result.content, truncated: result.truncated });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFilePreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) setFilePreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadPreview, selectedPath, workspaceRoot]);

  const handleSelect = (entry: FileSystemEntry) => {
    const absolutePath = toAbsolute(currentPath, entry.path);
    if (isDirType(entry.type)) {
      onNavigate(absolutePath);
    } else {
      setSelectedPath(absolutePath);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
      <aside className="flex min-h-0 w-96 shrink-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <FolderTreeIcon className="size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Files</p>
            <p className="truncate text-xs text-muted-foreground">
              {currentPath}
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span>Show all</span>
            <Switch
              aria-label="Show ignored files"
              checked={showAllFiles}
              onCheckedChange={onShowAllFilesChange}
              size="sm"
            />
          </label>
        </div>
        {canGoUp && (
          <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
            <button
              className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={() => onNavigate(parentPath)}
              title="Go to parent directory"
              type="button"
            >
              <ArrowUpIcon className="size-3" />
              <span>Up</span>
            </button>
            <button
              className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={() => onNavigate(workspaceRoot)}
              title="Go to home directory"
              type="button"
            >
              <HomeIcon className="size-3" />
              <span>Home</span>
            </button>
          </div>
        )}
        <div className="h-0 min-h-0 flex-1 overflow-auto p-3">
          {sorted.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {entries.length === 0 ? emptyTreeMessage : "Empty directory."}
            </p>
          ) : (
            <div className="font-mono text-sm" role="list">
              {sorted.map((entry) => {
                const absolutePath = toAbsolute(currentPath, entry.path);
                return (
                  <button
                    key={entry.path}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded border-none bg-transparent px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/50",
                      selectedPath === absolutePath && "bg-muted",
                    )}
                    onClick={() => handleSelect(entry)}
                    role="listitem"
                    tabIndex={0}
                    type="button"
                  >
                    {isDirType(entry.type) ? (
                      <FolderIcon className="size-4 shrink-0 text-blue-500" />
                    ) : (
                      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{entry.path}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <FileCode2Icon className="size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {selectedPath ?? "Select a file to preview"}
            </p>
            <p className="text-xs text-muted-foreground">
              {selectedPath
                ? "Previewing current workspace file"
                : "Select a file from the list"}
            </p>
          </div>
        </div>
        <div className="h-0 min-h-0 flex-1 overflow-auto">
          {!selectedPath ? (
            <EmptyPreview message="No file selected." />
          ) : filePreviewLoading ? (
            <EmptyPreview message="Loading..." />
          ) : filePreview ? (
            <pre className="whitespace-pre-wrap break-all p-4 text-xs font-mono">
              {filePreview.content}
              {filePreview.truncated && (
                <span className="text-muted-foreground">{"\n\n--- File truncated ---"}</span>
              )}
            </pre>
          ) : (
            <EmptyPreview message="Could not load file preview." />
          )}
        </div>
      </section>
    </div>
  );
}

function EmptyPreview({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-[20rem] items-center justify-center p-6 text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function toAbsolute(currentPath: string, name: string): string {
  return currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
}

function isDirType(type: FileSystemEntry["type"]): boolean {
  return type === "directory" || type === "symlink";
}
