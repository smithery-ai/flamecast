import { useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  ArrowUpIcon,
  FileIcon,
  FolderIcon,
  FolderTreeIcon,
  HomeIcon,
} from "lucide-react";
import type { FileSystemEntry } from "@flamecast/sdk/session";

export function RuntimeFileTree({
  workspaceRoot,
  entries,
  showAllFiles,
  onShowAllFilesChange,
  onFileSelect,
  defaultDirectory = "",
  emptyTreeMessage = "No filesystem entries returned.",
}: {
  workspaceRoot: string | null;
  entries: FileSystemEntry[];
  showAllFiles: boolean;
  onShowAllFilesChange: (showAllFiles: boolean) => void;
  onFileSelect: (path: string) => void;
  defaultDirectory?: string;
  emptyTreeMessage?: string;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [currentDirectory, setCurrentDirectory] = useState(defaultDirectory);

  const directoryContents = useMemo(
    () => getDirectoryContents(entries, currentDirectory),
    [entries, currentDirectory],
  );

  const isAtDefault = currentDirectory === defaultDirectory;
  const parentDirectory = getParentDirectory(currentDirectory);

  const handleSelect = (path: string, type: FileSystemEntry["type"]) => {
    if (type === "directory") {
      setCurrentDirectory(path);
    } else {
      setSelectedPath(path);
      onFileSelect(path);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <FolderTreeIcon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {currentDirectory || workspaceRoot || "Files"}
        </span>
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
      {(currentDirectory !== "" || !isAtDefault) && (
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          {currentDirectory !== "" && (
            <button
              className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={() => setCurrentDirectory(parentDirectory)}
              title="Go to parent directory"
              type="button"
            >
              <ArrowUpIcon className="size-3" />
              <span>Up</span>
            </button>
          )}
          {!isAtDefault && (
            <button
              className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={() => setCurrentDirectory(defaultDirectory)}
              title="Go to default directory"
              type="button"
            >
              <HomeIcon className="size-3" />
              <span>Root</span>
            </button>
          )}
        </div>
      )}
      <div className="h-0 min-h-0 flex-1 overflow-auto p-1.5">
        {directoryContents.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {entries.length === 0 ? emptyTreeMessage : "Empty directory."}
          </p>
        ) : (
          <div className="font-mono text-xs" role="tree">
            {directoryContents.map((item) => (
              <button
                key={item.path}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-1.5 rounded border-none bg-transparent px-2 py-1 text-left text-xs transition-colors hover:bg-muted/50",
                  selectedPath === item.path && "bg-muted",
                )}
                onClick={() => handleSelect(item.path, item.type)}
                role="treeitem"
                tabIndex={0}
                type="button"
              >
                {item.type === "directory" ? (
                  <FolderIcon className="size-4 shrink-0 text-blue-500" />
                ) : (
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{item.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function getDirectoryContents(
  entries: FileSystemEntry[],
  currentDirectory: string,
): { name: string; path: string; type: FileSystemEntry["type"] }[] {
  const prefix = currentDirectory ? currentDirectory + "/" : "";
  const seen = new Set<string>();
  const items: { name: string; path: string; type: FileSystemEntry["type"] }[] = [];

  for (const entry of entries) {
    if (!entry.path.startsWith(prefix) && currentDirectory !== "") continue;
    if (currentDirectory === "" && !entry.path.includes("/") && !seen.has(entry.path)) {
      // Top-level entry
      seen.add(entry.path);
      items.push({ name: entry.path, path: entry.path, type: entry.type });
      continue;
    }
    if (currentDirectory === "" && entry.path.includes("/")) {
      // Nested entry - show top-level directory
      const topDir = entry.path.split("/")[0]!;
      if (!seen.has(topDir)) {
        seen.add(topDir);
        items.push({ name: topDir, path: topDir, type: "directory" });
      }
      continue;
    }
    if (currentDirectory !== "" && entry.path.startsWith(prefix)) {
      const rest = entry.path.slice(prefix.length);
      if (!rest) continue;
      const segments = rest.split("/");
      const directChild = segments[0]!;
      const directChildPath = prefix + directChild;
      if (seen.has(directChildPath)) continue;
      seen.add(directChildPath);
      if (segments.length === 1) {
        items.push({ name: directChild, path: directChildPath, type: entry.type });
      } else {
        items.push({ name: directChild, path: directChildPath, type: "directory" });
      }
    }
  }

  // Sort: directories first, then alphabetically
  items.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });

  return items;
}

function getParentDirectory(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) return "";
  return segments.slice(0, -1).join("/");
}
