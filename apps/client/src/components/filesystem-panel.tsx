import { useEffect, useMemo, useState } from "react";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import { Switch } from "@/components/ui/switch";
import { FileCode2Icon, FolderTreeIcon } from "lucide-react";
import { useRuntimeFileSystemContext } from "@/contexts/runtime-filesystem-context";
import type { FileSystemEntry } from "@flamecast/sdk/session";

type TreeNode = {
  name: string;
  path: string;
  type: FileSystemEntry["type"];
  children: TreeNode[];
};

export function FileSystemPanel({
  workspaceRoot,
  entries,
  emptyTreeMessage = "No filesystem entries returned.",
}: {
  workspaceRoot: string | null;
  entries: FileSystemEntry[];
  emptyTreeMessage?: string;
}) {
  const {
    showAllFiles,
    setShowAllFiles: onShowAllFilesChange,
    loadPreview,
  } = useRuntimeFileSystemContext();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [filePreview, setFilePreview] = useState<{ content: string; truncated: boolean } | null>(
    null,
  );
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);

  const fileEntryMap = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry])),
    [entries],
  );
  const fileTree = useMemo(() => buildTree(entries), [entries]);

  useEffect(() => {
    setExpandedPaths((current) => (current.size > 0 ? current : getInitialExpandedPaths(fileTree)));
  }, [fileTree]);

  useEffect(() => {
    if (selectedPath && fileEntryMap.get(selectedPath)?.type === "file") {
      return;
    }

    const firstFile = entries.find((entry) => entry.type === "file");
    setSelectedPath(firstFile?.path ?? null);
  }, [entries, fileEntryMap, selectedPath]);

  const selectedEntry = selectedPath ? (fileEntryMap.get(selectedPath) ?? null) : null;

  useEffect(() => {
    if (!selectedPath || !selectedEntry || selectedEntry.type !== "file") {
      setFilePreview(null);
      return;
    }

    let cancelled = false;
    setFilePreviewLoading(true);
    loadPreview(selectedPath)
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
  }, [loadPreview, selectedEntry, selectedPath]);

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
  };

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
      <aside className="flex min-h-0 w-96 shrink-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <FolderTreeIcon className="size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Files</p>
            <p className="truncate text-xs text-muted-foreground">
              {workspaceRoot ?? "No workspace root"}
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
        <div className="h-0 min-h-0 flex-1 overflow-auto p-3">
          {fileTree.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{emptyTreeMessage}</p>
          ) : (
            <FileTree
              className="border-none bg-transparent"
              expanded={expandedPaths}
              onExpandedChange={setExpandedPaths}
              onSelect={handleTreeSelect}
              selectedPath={selectedPath ?? undefined}
            >
              {renderTree(fileTree)}
            </FileTree>
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
              {selectedEntry?.type === "file"
                ? "Previewing current workspace file"
                : "Select a file from the tree"}
            </p>
          </div>
        </div>
        <div className="h-0 min-h-0 flex-1 overflow-auto">
          {!selectedEntry ? (
            <EmptyPreview message="No file selected." />
          ) : selectedEntry.type !== "file" ? (
            <EmptyPreview message="Select a file to preview its contents." />
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
  const root: TreeNode = {
    name: "",
    path: "",
    type: "directory",
    children: [],
  };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let current = root;

    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      let child = current.children.find((candidate) => candidate.path === path);

      if (!child) {
        child = {
          name: segment,
          path,
          type: index === segments.length - 1 ? entry.type : "directory",
          children: [],
        };
        current.children.push(child);
      }

      if (index === segments.length - 1) {
        child.type = entry.type;
      }

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
    if (node.children.length > 0) {
      sortTree(node.children);
    }
  });
}

function getInitialExpandedPaths(nodes: TreeNode[]) {
  return new Set(nodes.filter((node) => node.type === "directory").map((node) => node.path));
}

function getParentPaths(path: string) {
  const segments = path.split("/").filter(Boolean);
  const parents: string[] = [];

  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }

  return parents;
}
