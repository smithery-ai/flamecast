import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import alchemy from "alchemy";
import type { AgentSpawn } from "../shared/session.js";
import type { AgentTemplateRuntime, SessionLog } from "../shared/session.js";
import { SESSION_EVENT_TYPES } from "../shared/session.js";
import type { AcpTransport } from "./transport.js";
import { findFreePort, openLocalTransport, openTcpTransport } from "./transport.js";

export type StartedRuntime = {
  transport: AcpTransport;
  terminate: () => Promise<void>;
  reconnect?: () => Promise<AcpTransport>;
  events?: ReadableStream<SessionLog>;
};

export type RuntimeProviderStartRequest = {
  runtime: AgentTemplateRuntime;
  spawn: AgentSpawn;
  sessionId: string;
  cwd: string;
};

export type RuntimeProvider = {
  start(request: RuntimeProviderStartRequest): Promise<StartedRuntime>;
  reconnect?: (request: RuntimeProviderStartRequest) => Promise<AcpTransport>;
};

export type RuntimeProviderRegistry = Record<string, RuntimeProvider>;

export type RuntimeProvisioner = (opts: {
  runtime: AgentTemplateRuntime;
  spawn: AgentSpawn;
  sessionId: string;
  cwd: string;
}) => Promise<{ transport: AcpTransport; events?: ReadableStream<SessionLog> }>;

type WaitForAcpOptions = {
  timeoutMs?: number;
  probeTimeoutMs?: number;
  retryDelayMs?: number;
};

type BuiltinRuntimeProviderOptions = {
  acpReadyTimeoutMs?: number;
  acpProbeTimeoutMs?: number;
  acpRetryDelayMs?: number;
};

let resourceScope: Promise<import("alchemy").Scope> | undefined;

export function resolveDockerBuildContext(dockerfile: string): string {
  const dockerfileDir = dirname(dockerfile);
  return basename(dockerfileDir) === "docker" ? resolve(dockerfileDir, "..") : dockerfileDir;
}

export async function waitForAcp(
  host: string,
  port: number,
  { timeoutMs = 30_000, probeTimeoutMs = 2_000, retryDelayMs = 200 }: WaitForAcpOptions = {},
): Promise<void> {
  const { createConnection } = await import("node:net");
  const effectiveProbeTimeoutMs = Math.min(probeTimeoutMs, timeoutMs);
  const effectiveRetryDelayMs = Math.min(retryDelayMs, timeoutMs);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: ReturnType<typeof createConnection> | undefined;

    const cleanupSocket = () => {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
      }

      /* v8 ignore next -- defensive when cleanup runs before a socket exists */
      if (!socket) {
        return;
      }

      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.destroy();
      socket = undefined;
    };

    const finish = (callback: () => void) => {
      /* v8 ignore next -- defensive against duplicate completion */
      if (settled) {
        return;
      }

      settled = true;

      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }

      clearTimeout(deadlineTimer);
      cleanupSocket();
      callback();
    };

    const scheduleRetry = () => {
      /* v8 ignore next -- defensive against late timer callbacks after settle */
      if (settled) {
        return;
      }

      cleanupSocket();
      retryTimer = setTimeout(connect, effectiveRetryDelayMs);
    };

    const connect = () => {
      /* v8 ignore next -- defensive against late retry timers after settle */
      if (settled) {
        return;
      }

      const attemptSocket = createConnection({ host, port }, () => {
        /* v8 ignore next -- defensive against late socket callbacks after cleanup */
        if (settled || socket !== attemptSocket) {
          return;
        }

        handshakeTimer = setTimeout(scheduleRetry, effectiveProbeTimeoutMs);
        attemptSocket.setNoDelay(true);
        attemptSocket.once("data", () => finish(resolve));
        attemptSocket.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: 1, clientCapabilities: {} },
          }) + "\n",
        );
      });

      socket = attemptSocket;
      attemptSocket.once("error", () => {
        /* v8 ignore next -- defensive against late socket errors after cleanup */
        if (settled || socket !== attemptSocket) {
          return;
        }

        scheduleRetry();
      });
    };

    const deadlineTimer = setTimeout(() => {
      finish(() =>
        reject(new Error(`ACP agent not ready on ${host}:${port} after ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    connect();
  });
}

type GitIgnoreRule = {
  negated: boolean;
  regex: RegExp;
};

async function loadGitIgnoreRules(workspaceRoot: string): Promise<GitIgnoreRule[]> {
  const defaultRules = [parseGitIgnoreRule(".git/")].filter(
    (rule): rule is GitIgnoreRule => rule !== null,
  );

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

function parseGitIgnoreRule(line: string): GitIgnoreRule | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const literal = trimmed.startsWith("\\#") || trimmed.startsWith("\\!");
  const negated = !literal && trimmed.startsWith("!");
  const rawPattern = negated ? trimmed.slice(1) : literal ? trimmed.slice(1) : trimmed;

  if (!rawPattern) {
    return null;
  }

  const directoryOnly = rawPattern.endsWith("/");
  const anchored = rawPattern.startsWith("/");
  const normalized = rawPattern.slice(anchored ? 1 : 0, directoryOnly ? -1 : undefined);

  if (!normalized) {
    return null;
  }

  const hasSlash = normalized.includes("/");
  const source = globToRegexSource(normalized);
  const regex = !hasSlash
    ? new RegExp(directoryOnly ? `(^|/)${source}(/|$)` : `(^|/)${source}$`, "u")
    : anchored
      ? new RegExp(directoryOnly ? `^${source}(/|$)` : `^${source}$`, "u")
      : new RegExp(directoryOnly ? `(^|.*/)${source}(/|$)` : `(^|.*/)${source}$`, "u");

  return { negated, regex };
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

function isGitIgnored(path: string, rules: GitIgnoreRule[]): boolean {
  let ignored = false;

  for (const rule of rules) {
    if (rule.regex.test(path)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

type FileSystemEntry = {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
};

type FileSystemSnapshot = {
  root: string;
  entries: FileSystemEntry[];
  truncated: boolean;
  maxEntries: number;
};

export async function buildFileSystemSnapshot(
  workspaceRoot: string,
  opts: { showAllFiles?: boolean } = {},
): Promise<FileSystemSnapshot> {
  const entries: FileSystemEntry[] = [];
  const gitIgnoreRules = opts.showAllFiles ? [] : await loadGitIgnoreRules(workspaceRoot);
  const queue = [workspaceRoot];

  for (let index = 0; index < queue.length; index += 1) {
    const dir = queue[index];
    const children = await readdir(dir, { withFileTypes: true });
    children.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const child of children) {
      const absolutePath = resolve(dir, child.name);
      const path = relative(workspaceRoot, absolutePath);
      if (isGitIgnored(path, gitIgnoreRules)) {
        continue;
      }

      const type: FileSystemEntry["type"] = child.isDirectory()
        ? "directory"
        : child.isFile()
          ? "file"
          : child.isSymbolicLink()
            ? "symlink"
            : "other";

      entries.push({ path, type });

      if (type === "directory") {
        queue.push(absolutePath);
      }
    }
  }

  return {
    root: workspaceRoot,
    entries,
    truncated: false,
    maxEntries: entries.length,
  };
}

export function createFileSystemEventStream(
  workspaceRoot: string,
): ReadableStream<SessionLog> | undefined {
  if (!existsSync(workspaceRoot)) {
    return undefined;
  }

  let watcher: FSWatcher;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  try {
    return new ReadableStream<SessionLog>({
      start(controller) {
        watcher = watch(workspaceRoot, { recursive: true }, () => {
          if (cancelled) return;

          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }

          debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            if (cancelled) return;

            void buildFileSystemSnapshot(workspaceRoot).then((snapshot) => {
              if (cancelled) return;
              controller.enqueue({
                timestamp: new Date().toISOString(),
                type: SESSION_EVENT_TYPES.FILESYSTEM_SNAPSHOT,
                data: { snapshot },
              });
            });
          }, 300);
        });
      },
      cancel() {
        cancelled = true;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        watcher?.close();
      },
    });
  } catch {
    return undefined;
  }
}

const localProvisioner: RuntimeProvisioner = async ({ spawn, cwd }) => ({
  transport: openLocalTransport(spawn),
  events: createFileSystemEventStream(cwd),
});

/* v8 ignore start -- docker provisioning requires a running Docker daemon */
export function createDockerProvisioner(
  options: BuiltinRuntimeProviderOptions = {},
): RuntimeProvisioner {
  return async ({ runtime, sessionId, cwd }) => {
    const provider = await import("alchemy/docker");
    const port = await findFreePort();
    const image = runtime.image;

    if (!image) {
      throw new Error('Docker runtime requires an "image" value');
    }
    if (runtime.dockerfile) {
      const dockerfile = runtime.dockerfile;
      await provider.Image("image", {
        name: image,
        tag: "latest",
        build: {
          context: resolveDockerBuildContext(dockerfile),
          dockerfile,
        },
        skipPush: true,
      });
    }

    const containerWorkDir = "/workspace";

    await provider.Container("sandbox", {
      image: `${image}:latest`,
      name: `flamecast-sandbox-${sessionId}`,
      environment: { ACP_PORT: String(port) },
      ports: [{ external: port, internal: port }],
      volumes: [{ hostPath: cwd, containerPath: containerWorkDir }],
      start: true,
    });

    await waitForAcp("localhost", port, {
      timeoutMs: options.acpReadyTimeoutMs,
      probeTimeoutMs: options.acpProbeTimeoutMs,
      retryDelayMs: options.acpRetryDelayMs,
    });

    return {
      transport: await openTcpTransport("localhost", port),
      events: createFileSystemEventStream(cwd),
    };
  };
}
/* v8 ignore stop */

export function createRuntimeProvider(provisioner: RuntimeProvisioner): RuntimeProvider {
  return {
    async start({ runtime, spawn, sessionId, cwd }) {
      resourceScope ??= alchemy("flame-resources", { quiet: true });
      const root = await resourceScope;

      return alchemy.run(`session-${sessionId}`, { parent: root }, async (scope) => {
        const { transport, events } = await provisioner({ runtime, spawn, sessionId, cwd });

        return {
          transport,
          events,
          terminate: async () => {
            await events?.cancel().catch(() => undefined);
            await transport.dispose?.();
            await alchemy.destroy(scope).catch(() => undefined);
          },
        };
      });
    },
  };
}

function createBuiltinRuntimeProviders(
  options: BuiltinRuntimeProviderOptions = {},
): RuntimeProviderRegistry {
  return {
    local: createRuntimeProvider(localProvisioner),
    docker: createRuntimeProvider(createDockerProvisioner(options)),
  };
}

export function resolveRuntimeProviders(
  overrides: RuntimeProviderRegistry = {},
): RuntimeProviderRegistry {
  return {
    ...createBuiltinRuntimeProviders(),
    ...overrides,
  };
}
