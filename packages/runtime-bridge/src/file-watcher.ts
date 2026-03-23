import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";

export type FileChange = {
  path: string;
  type: "added" | "modified" | "deleted";
};

/**
 * Start watching a directory for file changes.
 * Debounces changes and calls the callback with a batch.
 */
export function startFileWatcher(
  workspaceRoot: string,
  ignorePatterns: string[],
  onChange: (changes: FileChange[]) => void,
  debounceMs = 300,
): FSWatcher | undefined {
  if (!existsSync(workspaceRoot)) {
    return undefined;
  }

  let pending = new Map<string, FileChange>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (pending.size === 0) return;
    const changes = [...pending.values()];
    pending = new Map();
    onChange(changes);
  };

  const watcher = watch(workspaceRoot, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;

    // Check ignore patterns
    for (const pattern of ignorePatterns) {
      if (filename.includes(pattern)) return;
    }

    // Determine change type
    const fullPath = `${workspaceRoot}/${filename}`;
    const changeType: FileChange["type"] = existsSync(fullPath) ? "modified" : "deleted";

    pending.set(filename, { path: filename, type: changeType });

    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });

  return watcher;
}
