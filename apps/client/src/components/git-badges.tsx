/**
 * Renders git repo badges: a GitHub pill (icon + org/repo) if origin is a GitHub URL,
 * and a branch badge if not on main/master.
 */
export function GitBadges({
  branch,
  origin,
}: {
  branch?: string;
  origin?: string;
}) {
  const github = origin ? parseGitHubOrigin(origin) : null;
  const showBranch = branch && branch !== "main" && branch !== "master";

  if (!github && !showBranch) {
    // Fallback: just show branch name if present
    if (branch) {
      return (
        <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {branch}
        </span>
      );
    }
    return null;
  }

  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {github && (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <GitHubIcon className="size-2.5" />
          {github}
        </span>
      )}
      {showBranch && (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {branch}
        </span>
      )}
    </span>
  );
}

function parseGitHubOrigin(origin: string): string | null {
  // Handle SSH: git@github.com:org/repo.git
  const sshMatch = origin.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  // Handle HTTPS: https://github.com/org/repo.git
  try {
    const url = new URL(origin);
    if (url.hostname === "github.com") {
      const parts = url.pathname.replace(/\.git$/, "").replace(/^\//, "");
      if (parts.includes("/")) return parts;
    }
  } catch {
    // not a URL
  }
  return null;
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
