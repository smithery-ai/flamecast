import type { Runtime } from "@flamecast/protocol/runtime";

// All Node.js-specific imports are dynamic to avoid breaking edge bundles.
// NodeRuntime is re-exported via flamecast/index.ts which is shared between
// the Node entry point (index.ts) and the edge entry point (edge.ts).

/** Minimal subset of ChildProcess we use. */
interface ManagedProcess {
  killed: boolean;
  stdout: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

type RuntimeEntryGitInfo = {
  branch: string;
  origin?: string;
};

type RuntimeEntry = {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  git?: RuntimeEntryGitInfo;
};

type GitIgnoreRule = {
  negated: boolean;
  regex: RegExp;
};

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

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

function parseGitIgnoreRules(content: string): GitIgnoreRule[] {
  const rules = [parseGitIgnoreRule(".git/")].filter(
    (rule): rule is GitIgnoreRule => rule !== null,
  );
  const extra = process.env.FILE_WATCHER_IGNORE;
  if (extra) {
    for (const pattern of extra.split(",")) {
      const rule = parseGitIgnoreRule(pattern.trim());
      if (rule) rules.push(rule);
    }
  }

  for (const line of content.split(/\r?\n/u)) {
    const rule = parseGitIgnoreRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
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

/**
 * NodeRuntime — manages a local runtime-host Go binary.
 *
 * By default, resolves and spawns the Go binary from `@flamecast/session-host-go/dist`.
 * Pass a URL explicitly to connect to an already-running runtime-host instead.
 */
export class NodeRuntime implements Runtime {
  readonly onlyOne = true;

  private readonly explicitUrl: string | undefined;
  private readonly cwd: string | undefined;
  private process: ManagedProcess | null = null;
  private url: string | null = null;
  private starting: Promise<void> | null = null;

  constructor(urlOrOpts?: string | { url?: string; cwd?: string }) {
    if (typeof urlOrOpts === "string") {
      this.explicitUrl = urlOrOpts;
      this.url = urlOrOpts;
    } else if (urlOrOpts) {
      this.explicitUrl = urlOrOpts.url;
      if (urlOrOpts.url) this.url = urlOrOpts.url;
      this.cwd = urlOrOpts.cwd;
    }
  }

  /** The workspace root for local file operations. */
  getDefaultCwd(): string {
    return this.cwd ?? process.cwd();
  }

  private getWorkspaceRoot(): string {
    return this.getDefaultCwd();
  }

  async start(_instanceId: string): Promise<void> {
    await this.ensureRunning();
  }

  async stop(_instanceId: string): Promise<void> {
    await this.dispose();
  }

  async getInstanceStatus(
    _instanceId: string,
  ): Promise<"running" | "stopped" | "paused" | undefined> {
    if (this.explicitUrl) return "running";
    if (this.url && this.process && !this.process.killed) return "running";
    return undefined;
  }

  private async ensureRunning(): Promise<string> {
    // If an explicit URL was provided, just use it (externally managed)
    if (this.explicitUrl) return this.explicitUrl;

    // Already running
    if (this.url && this.process && !this.process.killed) return this.url;

    // Another call is already starting the process
    if (this.starting) {
      await this.starting;
      if (!this.url) throw new Error("Runtime-host failed to start");
      return this.url;
    }

    this.starting = this.spawnRuntimeHost();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    if (!this.url) throw new Error("Runtime-host failed to start");
    return this.url;
  }

  private async spawnRuntimeHost(): Promise<void> {
    const { resolveNativeBinary } = await import("@flamecast/session-host-go/resolve");
    const { spawn } = await import("node:child_process");

    const binaryPath = resolveNativeBinary();
    if (!binaryPath) {
      throw new Error(
        "No native runtime-host binary found. Run: pnpm --filter @flamecast/session-host-go run postinstall",
      );
    }

    const port = await findFreePort();

    const proc = spawn(binaryPath, [], {
      env: { ...process.env, SESSION_HOST_PORT: String(port) },
      stdio: ["ignore", "pipe", "inherit"],
    });

    this.process = proc;

    // Wait for the "listening on port" message
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error("Runtime-host did not start within 15s"));
      }, 15_000);

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        process.stdout.write(text);
        buffer += text;
        if (buffer.includes("listening on port")) {
          clearTimeout(timeout);
          proc.stdout?.removeListener("data", onData);
          // Pipe remaining output
          proc.stdout?.pipe(process.stdout);
          resolve();
        }
      };

      proc.stdout?.on("data", onData);
      proc.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
      proc.on("exit", (code: number | null) => {
        clearTimeout(timeout);
        this.process = null;
        this.url = null;
        reject(new Error(`Runtime-host exited with code ${code}`));
      });
    });

    this.url = `http://localhost:${port}`;

    // Clean up on unexpected exit
    proc.on("exit", () => {
      if (this.process === proc) {
        this.process = null;
        this.url = null;
      }
    });
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const originalUrl = new URL(request.url);
    const sessionCwd = request.headers.get("x-session-cwd") ?? undefined;

    // Handle filesystem snapshot locally (shallow, single-level listing)
    // instead of proxying to the Go sidecar which may not support the path param.
    if (!this.explicitUrl && originalUrl.pathname === "/fs/snapshot" && request.method === "GET") {
      return this.handleRuntimeFsSnapshot(originalUrl, sessionCwd);
    }

    if (!this.explicitUrl && originalUrl.pathname === "/files" && request.method === "GET") {
      return this.handleRuntimeFilePreview(originalUrl);
    }

    const baseUrl = await this.ensureRunning();
    const targetUrl = new URL(baseUrl);
    targetUrl.pathname = `/sessions/${sessionId}${originalUrl.pathname}`;
    targetUrl.search = originalUrl.search;

    const init: RequestInit & { duplex?: string } = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      duplex: request.body ? "half" : undefined,
    };
    const resp = await fetch(targetUrl.toString(), init);

    // For /start responses, inject the runtime-host URLs (shared across all sessions)
    if (originalUrl.pathname.endsWith("/start") && request.method === "POST" && resp.ok) {
      const body = await resp.json();
      const runtimeUrl = new URL(baseUrl);
      body.hostUrl = runtimeUrl.toString().replace(/\/$/, "");
      body.websocketUrl = runtimeUrl.toString().replace(/^http/, "ws").replace(/\/$/, "");
      return new Response(JSON.stringify(body), {
        status: resp.status,
        headers: resp.headers,
      });
    }

    return resp;
  }

  async fetchInstance(_instanceId: string, request: Request): Promise<Response> {
    const originalUrl = new URL(request.url);

    if (!this.explicitUrl && originalUrl.pathname === "/files" && request.method === "GET") {
      return this.handleRuntimeFilePreview(originalUrl);
    }

    if (!this.explicitUrl && originalUrl.pathname === "/fs/snapshot" && request.method === "GET") {
      return this.handleRuntimeFsSnapshot(originalUrl);
    }

    if (
      !this.explicitUrl &&
      originalUrl.pathname === "/fs/git/branches" &&
      request.method === "GET"
    ) {
      return handleGitBranches(this.getWorkspaceRoot(), originalUrl);
    }

    if (
      !this.explicitUrl &&
      originalUrl.pathname === "/fs/git/commits" &&
      request.method === "GET"
    ) {
      return handleGitCommits(this.getWorkspaceRoot(), originalUrl);
    }

    if (
      !this.explicitUrl &&
      originalUrl.pathname === "/fs/git/worktrees" &&
      request.method === "GET"
    ) {
      return handleGitWorktreesList(this.getWorkspaceRoot(), originalUrl);
    }

    if (
      !this.explicitUrl &&
      originalUrl.pathname === "/fs/git/worktrees" &&
      request.method === "POST"
    ) {
      return handleGitWorktreeCreate(this.getWorkspaceRoot(), request);
    }

    const baseUrl = await this.ensureRunning();
    const targetUrl = new URL(baseUrl);
    targetUrl.pathname = originalUrl.pathname;
    targetUrl.search = originalUrl.search;

    const init: RequestInit & { duplex?: string } = {
      method: request.method,
      headers: request.headers,
      body: request.body,
      duplex: request.body ? "half" : undefined,
    };
    return fetch(targetUrl.toString(), init);
  }

  getWebsocketUrl(_instanceId?: string): string | undefined {
    if (!this.url) return undefined;
    return this.url.replace(/^http/, "ws");
  }

  async dispose(): Promise<void> {
    const proc = this.process;
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      // Give it a moment to shut down gracefully
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 3_000);
        proc.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.process = null;
    this.url = null;
  }

  private async handleRuntimeFilePreview(url: URL): Promise<Response> {
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      return jsonResponse({ error: "Missing ?path= parameter" }, 400);
    }

    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const workspaceRoot = this.getWorkspaceRoot();
    const resolvedPath = resolveWorkspacePath(workspaceRoot, filePath, path);
    if (!resolvedPath) {
      return jsonResponse({ error: "Path outside workspace" }, 403);
    }

    let content: string;
    try {
      content = await readFile(resolvedPath, "utf8");
    } catch {
      return jsonResponse({ error: `Cannot read: ${filePath}` }, 404);
    }

    const maxChars = 100_000;
    return jsonResponse({
      path: filePath,
      content: content.slice(0, maxChars),
      truncated: content.length > maxChars,
      maxChars,
    });
  }

  private async handleRuntimeFsSnapshot(
    url: URL,
    workspaceRootOverride?: string,
  ): Promise<Response> {
    const { readFile, readdir, stat, access } = await import("node:fs/promises");
    const path = await import("node:path");

    const workspaceRoot = workspaceRootOverride ?? this.getWorkspaceRoot();
    const requestedPath = url.searchParams.get("path");
    const targetDir = requestedPath ? path.resolve(requestedPath) : workspaceRoot;
    const showAllFiles = url.searchParams.get("showAllFiles") === "true";
    const rules: GitIgnoreRule[] = [];
    if (!showAllFiles) {
      // Read .gitignore from the directory being listed
      const gitIgnoreContents = await readFile(path.join(targetDir, ".gitignore"), "utf8").catch(
        () => "",
      );
      rules.push(...parseGitIgnoreRules(gitIgnoreContents));
    }
    const entries: RuntimeEntry[] = [];

    const dirents = await readdir(targetDir, { withFileTypes: true }).catch(() => null);
    if (dirents) {
      dirents.sort((left, right) => left.name.localeCompare(right.name));
      for (const dirent of dirents) {
        const name = dirent.name;
        if (!showAllFiles && name.startsWith(".")) continue;
        if (!showAllFiles && rules.length > 0 && isGitIgnored(name, rules)) continue;
        let type: RuntimeEntry["type"];
        let isDir = false;
        if (dirent.isDirectory()) {
          type = "directory";
          isDir = true;
        } else if (dirent.isFile()) {
          type = "file";
        } else if (dirent.isSymbolicLink()) {
          // Resolve symlink to determine if it points to a directory
          const resolved = await stat(path.join(targetDir, name)).catch(() => null);
          isDir = resolved?.isDirectory() ?? false;
          type = isDir ? "directory" : "file";
        } else {
          type = "other";
        }
        const entry: RuntimeEntry = { path: name, type };
        // Check if this directory is a git repo
        if (isDir) {
          const gitInfo = await readGitInfo(path.join(targetDir, name), readFile);
          if (gitInfo) entry.git = gitInfo;
        }
        entries.push(entry);
      }
    }

    // Find git root for the target directory itself
    const gitPath = await findGitRoot(targetDir, access);

    const maxEntries = 10_000;
    const result: Record<string, unknown> = {
      root: workspaceRoot,
      path: targetDir,
      entries: entries.slice(0, maxEntries),
      truncated: entries.length > maxEntries,
      maxEntries,
    };
    if (gitPath) result.gitPath = gitPath;
    return jsonResponse(result);
  }
}

function findFreePort(): Promise<number> {
  return import("node:net").then(
    ({ createServer }) =>
      new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, () => {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          server.close(() => resolve(port));
        });
        server.on("error", reject);
      }),
  );
}

async function readGitInfo(
  dir: string,
  readFile: typeof import("node:fs/promises").readFile,
): Promise<RuntimeEntryGitInfo | null> {
  const path = await import("node:path");
  const gitDir = path.join(dir, ".git");
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(gitDir);
    if (!s.isDirectory()) return null;
  } catch {
    return null;
  }

  const info: RuntimeEntryGitInfo = { branch: "" };

  // Read current branch from HEAD
  try {
    const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    if (head.startsWith("ref: refs/heads/")) {
      info.branch = head.slice("ref: refs/heads/".length);
    } else {
      info.branch = head.slice(0, 12); // detached HEAD — short hash
    }
  } catch {
    // ignore
  }

  // Read origin URL from config
  try {
    const config = await readFile(path.join(gitDir, "config"), "utf8");
    const lines = config.split("\n");
    let inRemoteOrigin = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '[remote "origin"]') {
        inRemoteOrigin = true;
        continue;
      }
      if (trimmed.startsWith("[")) {
        inRemoteOrigin = false;
        continue;
      }
      if (inRemoteOrigin && trimmed.startsWith("url = ")) {
        info.origin = trimmed.slice("url = ".length);
        break;
      }
    }
  } catch {
    // ignore
  }

  return info;
}

async function findGitRoot(
  dir: string,
  access: typeof import("node:fs/promises").access,
): Promise<string | null> {
  const path = await import("node:path");
  let cur = dir;
  for (;;) {
    try {
      await access(path.join(cur, ".git"));
      return cur;
    } catch {
      // not found, go up
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// ---------------------------------------------------------------------------
// Git helpers — shell out to `git` for operations that need more than .git/ parsing
// ---------------------------------------------------------------------------

async function execGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
        exitCode: error ? 1 : 0,
      });
    });
  });
}

async function handleGitBranches(workspaceRoot: string, url: URL): Promise<Response> {
  const path = await import("node:path");
  const requestedPath = url.searchParams.get("path");
  const targetDir = requestedPath ? path.resolve(requestedPath) : workspaceRoot;

  const { stdout, stderr, exitCode } = await execGit(
    ["branch", "-a", "--format=%(refname:short)\t%(objectname:short)\t%(HEAD)"],
    targetDir,
  );
  if (exitCode !== 0) {
    return jsonResponse({ error: stderr.trim() || "Not a git repository" }, 400);
  }

  // Deduplicate: prefer origin/ branches, only include local if no remote equivalent.
  // Strip "origin/" prefix from remote branch names for display.
  const raw = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha, head] = line.split("\t");
      return { name, sha, current: head === "*" };
    });

  const remotePrefix = "origin/";
  const remoteNames = new Set<string>();
  const localNames = new Set<string>();

  for (const b of raw) {
    if (b.name.startsWith(remotePrefix)) {
      remoteNames.add(b.name.slice(remotePrefix.length));
    } else {
      localNames.add(b.name);
    }
  }

  const branches: Array<{ name: string; sha: string; current: boolean; remote: boolean }> = [];

  // Add remote branches first (stripped of origin/ prefix)
  for (const b of raw) {
    if (!b.name.startsWith(remotePrefix)) continue;
    const shortName = b.name.slice(remotePrefix.length);
    if (shortName === "HEAD") continue;
    const localBranch = raw.find((l) => l.name === shortName);
    branches.push({
      name: shortName,
      sha: b.sha,
      current: localBranch?.current ?? false,
      remote: true,
    });
  }

  // Add local-only branches (no remote equivalent)
  for (const b of raw) {
    if (b.name.startsWith(remotePrefix)) continue;
    if (remoteNames.has(b.name)) continue; // already included via remote
    branches.push({ name: b.name, sha: b.sha, current: b.current, remote: false });
  }

  return jsonResponse({ branches });
}

async function handleGitCommits(workspaceRoot: string, url: URL): Promise<Response> {
  const path = await import("node:path");
  const requestedPath = url.searchParams.get("path");
  const targetDir = requestedPath ? path.resolve(requestedPath) : workspaceRoot;

  const branch = url.searchParams.get("branch") || "HEAD";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 200);

  const { stdout, stderr, exitCode } = await execGit(
    ["log", branch, `--max-count=${limit}`, "--format=%H\t%h\t%an\t%ae\t%aI\t%s"],
    targetDir,
  );
  if (exitCode !== 0) {
    return jsonResponse({ error: stderr.trim() || "Failed to list commits" }, 400);
  }

  const commits = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, authorName, authorEmail, date, ...rest] = line.split("\t");
      return { sha, shortSha, authorName, authorEmail, date, message: rest.join("\t") };
    });

  return jsonResponse({ branch, commits });
}

async function handleGitWorktreesList(workspaceRoot: string, url: URL): Promise<Response> {
  const path = await import("node:path");
  const requestedPath = url.searchParams.get("path");
  const targetDir = requestedPath ? path.resolve(requestedPath) : workspaceRoot;

  const { stdout, stderr, exitCode } = await execGit(
    ["worktree", "list", "--porcelain"],
    targetDir,
  );
  if (exitCode !== 0) {
    return jsonResponse({ error: stderr.trim() || "Failed to list worktrees" }, 400);
  }

  const worktrees: Array<Record<string, string | boolean>> = [];
  let current: Record<string, string | boolean> = {};
  for (const line of stdout.split("\n")) {
    if (line === "") {
      if (Object.keys(current).length > 0) {
        worktrees.push(current);
        current = {};
      }
      continue;
    }
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.sha = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  if (Object.keys(current).length > 0) worktrees.push(current);

  return jsonResponse({ worktrees });
}

async function handleGitWorktreeCreate(workspaceRoot: string, request: Request): Promise<Response> {
  const pathMod = await import("node:path");

  let body: {
    path?: string;
    name: string;
    branch?: string;
    newBranch?: boolean;
    startPoint?: string;
  };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!body.name) {
    return jsonResponse({ error: "Missing 'name' field" }, 400);
  }

  const requestedPath = body.path;
  const targetDir = requestedPath ? pathMod.resolve(requestedPath) : workspaceRoot;

  // Place worktrees under {serverCwd}/worktrees/{repoDirectoryName}/{worktreeName}
  const repoDirName = pathMod.basename(targetDir);
  const worktreePath = pathMod.resolve(
    workspaceRoot,
    ".flamecast",
    "worktrees",
    repoDirName,
    body.name,
  );
  // git worktree add <path> -b <new-branch> <start-point>
  // git worktree add <path> <existing-branch>
  const args = ["worktree", "add", worktreePath];
  if (body.newBranch && body.branch) {
    args.push("-b", body.branch);
    if (body.startPoint) {
      args.push(body.startPoint);
    }
  } else if (body.branch) {
    args.push(body.branch);
  }

  const { stdout, stderr, exitCode } = await execGit(args, targetDir);
  if (exitCode !== 0) {
    return jsonResponse({ error: stderr.trim() || "Failed to create worktree" }, 400);
  }

  return jsonResponse({ path: worktreePath, message: stdout.trim() || "Worktree created" }, 201);
}

function resolveWorkspacePath(
  workspaceRoot: string,
  filePath: string,
  path: typeof import("node:path"),
): string | null {
  if (!filePath || filePath.includes("\0") || path.isAbsolute(filePath)) return null;
  const resolvedPath = path.resolve(workspaceRoot, filePath);
  const relativePath = path.relative(workspaceRoot, resolvedPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return resolvedPath;
}
