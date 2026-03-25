import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export type WalkEntry = {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
};

// ---------------------------------------------------------------------------
// .gitignore parser (ported from runtime-provider.ts)
// ---------------------------------------------------------------------------

type GitIgnoreRule = {
  negated: boolean;
  regex: RegExp;
};

function globToRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if ("\\^$+?.()|{}[]".includes(char)) {
      source += `\\${char}`;
      continue;
    }
    source += char;
  }
  return source;
}

function parseGitIgnoreRule(line: string): GitIgnoreRule | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const literal = trimmed.startsWith("\\#") || trimmed.startsWith("\\!");
  const negated = !literal && trimmed.startsWith("!");
  const rawPattern = negated ? trimmed.slice(1) : literal ? trimmed.slice(1) : trimmed;
  if (!rawPattern) return null;

  const directoryOnly = rawPattern.endsWith("/");
  const anchored = rawPattern.startsWith("/");
  const normalized = rawPattern.slice(anchored ? 1 : 0, directoryOnly ? -1 : undefined);
  if (!normalized) return null;

  const hasSlash = normalized.includes("/");
  const source = globToRegexSource(normalized);
  const regex = !hasSlash
    ? new RegExp(directoryOnly ? `(^|/)${source}(/|$)` : `(^|/)${source}$`, "u")
    : anchored
      ? new RegExp(directoryOnly ? `^${source}(/|$)` : `^${source}$`, "u")
      : new RegExp(directoryOnly ? `(^|.*/)${source}(/|$)` : `(^|.*/)${source}$`, "u");

  return { negated, regex };
}

function isGitIgnored(path: string, rules: GitIgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(path)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

async function loadGitIgnoreRules(workspaceRoot: string): Promise<GitIgnoreRule[]> {
  // .git is always ignored
  const defaultRules = [parseGitIgnoreRule(".git/")].filter(
    (rule): rule is GitIgnoreRule => rule !== null,
  );

  // Merge FILE_WATCHER_IGNORE env var as additional rules
  const extra = process.env.FILE_WATCHER_IGNORE;
  if (extra) {
    for (const p of extra.split(",")) {
      const rule = parseGitIgnoreRule(p.trim());
      if (rule) defaultRules.push(rule);
    }
  }

  try {
    const content = await readFile(resolve(workspaceRoot, ".gitignore"), "utf8");
    return [
      ...defaultRules,
      ...content
        .split(/\r?\n/u)
        .map(parseGitIgnoreRule)
        .filter((rule): rule is GitIgnoreRule => rule !== null),
    ];
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return defaultRules;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

/**
 * Recursively walk a directory and return all entries with paths relative to `root`.
 * Respects `.gitignore` rules (globs, negation, directory-only patterns).
 */
export async function walkDirectory(root: string): Promise<WalkEntry[]> {
  const rules = await loadGitIgnoreRules(root);
  const entries: WalkEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      const fullPath = join(dir, dirent.name);
      const relPath = relative(root, fullPath);

      if (isGitIgnored(relPath, rules)) continue;

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
