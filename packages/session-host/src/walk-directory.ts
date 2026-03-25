import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export type WalkEntry = {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
};

/** Directories always ignored during walk. */
const ALWAYS_IGNORE = new Set(["node_modules", ".git"]);

/** Parse extra ignore patterns from the FILE_WATCHER_IGNORE env var (comma-separated). */
function getIgnorePatterns(): Set<string> {
  const extra = process.env.FILE_WATCHER_IGNORE;
  if (!extra) return ALWAYS_IGNORE;
  const merged = new Set(ALWAYS_IGNORE);
  for (const p of extra.split(",")) {
    const trimmed = p.trim();
    if (trimmed) merged.add(trimmed);
  }
  return merged;
}

/**
 * Recursively walk a directory and return all entries with paths relative to `root`.
 * Ignores `node_modules`, `.git`, and patterns from `FILE_WATCHER_IGNORE`.
 */
export async function walkDirectory(root: string): Promise<WalkEntry[]> {
  const ignore = getIgnorePatterns();
  const entries: WalkEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      // If we can't read a directory, skip it silently
      return;
    }

    for (const dirent of dirents) {
      if (ignore.has(dirent.name)) continue;

      const fullPath = join(dir, dirent.name);
      const relPath = relative(root, fullPath);

      if (dirent.isDirectory()) {
        entries.push({ path: relPath, type: "directory" });
        await walk(fullPath);
      } else if (dirent.isSymbolicLink()) {
        entries.push({ path: relPath, type: "symlink" });
      } else if (dirent.isFile()) {
        entries.push({ path: relPath, type: "file" });
      } else {
        entries.push({ path: relPath, type: "other" });
      }
    }
  }

  await walk(root);
  return entries;
}
