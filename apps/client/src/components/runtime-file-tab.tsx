import { useEffect, useState } from "react";
import { FileCode2Icon, LoaderCircleIcon } from "lucide-react";

export function RuntimeFileTab({
  filePath,
  loadPreview,
}: {
  filePath: string;
  loadPreview: (path: string) => Promise<{ content: string; truncated: boolean }>;
}) {
  const [preview, setPreview] = useState<{ content: string; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    loadPreview(filePath)
      .then((result) => {
        if (!cancelled) {
          setPreview(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setPreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, loadPreview]);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        Loading file...
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Could not load file preview.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <FileCode2Icon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 truncate text-xs text-muted-foreground">{filePath}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <pre className="whitespace-pre-wrap break-all p-4 text-xs font-mono">
          {preview.content}
          {preview.truncated && (
            <span className="text-muted-foreground">{"\n\n--- File truncated ---"}</span>
          )}
        </pre>
      </div>
    </div>
  );
}
