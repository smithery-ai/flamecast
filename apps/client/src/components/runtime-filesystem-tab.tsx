import { useRuntimeFileSystem, useFlamecastClient } from "@flamecast/ui";
import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RuntimeFileTree } from "@/components/runtime-file-tree";
import { RuntimeFileTab } from "@/components/runtime-file-tab";

export function RuntimeFilesystemTab({
  instanceName,
  cwd,
  onOpenFileTab,
}: {
  instanceName: string;
  cwd?: string;
  onOpenFileTab?: (filePath: string) => void;
}) {
  const client = useFlamecastClient();
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [fsPath, setFsPath] = useState<string | undefined>(cwd);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);

  const fsQuery = useRuntimeFileSystem(instanceName, {
    showAllFiles,
    path: fsPath,
  });

  const loadPreview = useCallback(
    (path: string) => client.fetchRuntimeFilePreview(instanceName, path),
    [client, instanceName],
  );

  const handleFileSelect = useCallback(
    (filePath: string) => {
      if (onOpenFileTab) {
        onOpenFileTab(filePath);
      } else {
        setPreviewFilePath(filePath);
      }
    },
    [onOpenFileTab],
  );

  if (previewFilePath) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center border-b px-3 py-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPreviewFilePath(null)}
            className="text-xs"
          >
            Back to files
          </Button>
          <span className="ml-2 truncate text-xs text-muted-foreground">{previewFilePath}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <RuntimeFileTab filePath={previewFilePath} loadPreview={loadPreview} />
        </div>
      </div>
    );
  }

  if (fsQuery.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-3">
        <Skeleton className="h-4 w-32" />
        <div className="flex flex-col gap-1 pt-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="size-4 shrink-0 rounded" />
              <Skeleton className="h-3.5" style={{ width: `${40 + Math.random() * 60}%` }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (fsQuery.isError || !fsQuery.data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
        <p className="text-xs text-muted-foreground">Could not load filesystem</p>
        <Button variant="outline" size="sm" onClick={() => void fsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <RuntimeFileTree
        workspaceRoot={fsQuery.data.root}
        currentPath={fsQuery.data.path ?? fsQuery.data.root}
        entries={fsQuery.data.entries}
        showAllFiles={showAllFiles}
        onShowAllFilesChange={setShowAllFiles}
        onFileSelect={handleFileSelect}
        onNavigate={setFsPath}
      />
    </div>
  );
}
