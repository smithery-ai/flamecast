import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { walkDirectory } from "./walk-directory.js";

export async function readWorkspaceFile(root: string, filePath: string) {
  const resolved = resolve(root, filePath);
  if (!resolved.startsWith(root)) {
    return { status: 403, body: { error: "Path outside workspace" } };
  }

  try {
    const raw = await readFile(resolved, "utf8");
    const maxChars = 100_000;
    const truncated = raw.length > maxChars;
    const content = truncated ? raw.slice(0, maxChars) : raw;
    return {
      status: 200,
      body: { path: filePath, content, truncated, maxChars },
    };
  } catch {
    return { status: 404, body: { error: `Cannot read: ${filePath}` } };
  }
}

export async function snapshotWorkspace(root: string, opts: { showAllFiles?: boolean } = {}) {
  const entries = await walkDirectory(root, opts);
  const maxEntries = 10_000;
  const truncated = entries.length > maxEntries;
  const limited = truncated ? entries.slice(0, maxEntries) : entries;
  return {
    status: 200,
    body: { root, entries: limited, truncated, maxEntries },
  };
}
