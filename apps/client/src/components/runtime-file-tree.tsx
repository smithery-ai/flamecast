import { useEffect, useMemo, useState } from "react";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import { Switch } from "@/components/ui/switch";
import { FolderTreeIcon } from "lucide-react";
import type { FileSystemEntry } from "@flamecast/sdk/session";

type TreeNode = {
  name: string;
  path: string;
  type: FileSystemEntry["type"];
  children: TreeNode[];
};

export function RuntimeFileTree({
  workspaceRoot,
  entries,
  showAllFiles,
  onShowAllFilesChange,
  onFileSelect,
  emptyTreeMessage = "No filesystem entries returned.",
}: {
  workspaceRoot: string | null;
  entries: FileSystemEntry[];
  showAllFiles: boolean;
  onShowAllFilesChange: (showAllFiles: boolean) => void;
  onFileSelect: (path: string) => void;
  emptyTreeMessage?: string;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  const fileEntryMap = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry])),
    [entries],
  );
  const fileTree = useMemo(() => buildTree(entries), [entries]);

  useEffect(() => {
    setExpandedPaths((current) => (current.size > 0 ? current : getInitialExpandedPaths(fileTree)));
  }, [fileTree]);

  const handleTreeSelect = (path: string) => {
    setSelectedPath(path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      for (const parentPath of getParentPaths(path)) {
        next.add(parentPath);
      }
      const entry = fileEntryMap.get(path);
      if (entry?.type === "directory") {
        next.add(path);
      }
      return next;
    });

    const entry = fileEntryMap.get(path);
    if (entry?.type === "file") {
      onFileSelect(path);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <FolderTreeIcon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {workspaceRoot ?? "Files"}
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
      <div className="h-0 min-h-0 flex-1 overflow-auto p-1.5">
        {fileTree.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{emptyTreeMessage}</p>
        ) : (
          <FileTree
            className="border-none bg-transparent text-xs"
            expanded={expandedPaths}
            onExpandedChange={setExpandedPaths}
            onSelect={handleTreeSelect}
            selectedPath={selectedPath ?? undefined}
          >
            {renderTree(fileTree)}
          </FileTree>
        )}
      </div>
    </div>
  );
}

function renderTree(nodes: TreeNode[]) {
  return nodes.map((node) =>
    node.type === "directory" ? (
      <FileTreeFolder key={node.path} name={node.name} path={node.path}>
        {renderTree(node.children)}
      </FileTreeFolder>
    ) : (
      <FileTreeFile key={node.path} name={node.name} path={node.path} />
    ),
  );
}

function buildTree(entries: FileSystemEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "directory", children: [] };
  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let current = root;
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      let child = current.children.find((c) => c.path === path);
      if (!child) {
        child = {
          name: segment,
          path,
          type: index === segments.length - 1 ? entry.type : "directory",
          children: [],
        };
        current.children.push(child);
      }
      if (index === segments.length - 1) child.type = entry.type;
      current = child;
    });
  }
  sortTree(root.children);
  return root.children;
}

function sortTree(nodes: TreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
  nodes.forEach((node) => {
    if (node.children.length > 0) sortTree(node.children);
  });
}

function getInitialExpandedPaths(nodes: TreeNode[]) {
  return new Set(nodes.filter((n) => n.type === "directory").map((n) => n.path));
}

function getParentPaths(path: string) {
  const segments = path.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    parents.push(segments.slice(0, i + 1).join("/"));
  }
  return parents;
}
