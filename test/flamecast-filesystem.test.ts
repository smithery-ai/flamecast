/* eslint-disable no-type-assertion/no-type-assertion */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, expect, test, vi } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { MemoryFlamecastStorage } from "../src/flamecast/state-managers/memory/index.js";

type ManagedAgentLike = {
  id: string;
  agentName: string;
  spawn: { command: string; args: string[] };
  runtime: { provider: string };
  transport: {
    input: WritableStream<Uint8Array>;
    output: ReadableStream<Uint8Array>;
    dispose?: () => Promise<void>;
  };
  terminate: () => Promise<void>;
  connection: acp.ClientSideConnection;
  sessionTextChunkLogBuffers: Map<string, unknown>;
};

function createAgentMeta(id: string) {
  return {
    id,
    agentName: "Example agent",
    spawn: { command: "node", args: ["agent.js"] },
    runtime: { provider: "local" as const },
    startedAt: "2024-01-01T00:00:00.000Z",
    lastUpdatedAt: "2024-01-01T00:00:00.000Z",
    latestSessionId: null,
    sessionCount: 0,
  };
}

function createSessionMeta(id: string, agentId: string, cwd: string) {
  return {
    id,
    agentId,
    agentName: "Example agent",
    spawn: { command: "node", args: ["agent.js"] },
    cwd,
    startedAt: "2024-01-01T00:00:00.000Z",
    lastUpdatedAt: "2024-01-01T00:00:00.000Z",
    pendingPermission: null,
  };
}

function createManagedAgent(id: string): ManagedAgentLike {
  const passthrough = new TransformStream<Uint8Array, Uint8Array>();
  return {
    id,
    agentName: "Example agent",
    spawn: { command: "node", args: ["agent.js"] },
    runtime: { provider: "local" },
    transport: {
      input: passthrough.writable,
      output: passthrough.readable,
    },
    terminate: vi.fn(async () => {}),
    connection: null as unknown as acp.ClientSideConnection,
    sessionTextChunkLogBuffers: new Map(),
  };
}

function attachStorage(flamecast: Flamecast, storage = new MemoryFlamecastStorage()) {
  Reflect.set(flamecast, "storage", storage);
  Reflect.set(flamecast, "readyPromise", Promise.resolve());
  return storage;
}

function attachAgent(flamecast: Flamecast, managed: ManagedAgentLike) {
  const agents = Reflect.get(flamecast, "agents") as Map<string, ManagedAgentLike>;
  agents.set(managed.id, managed);
}

function attachSession(flamecast: Flamecast, sessionId: string, agentId: string) {
  const sessionToAgentId = Reflect.get(flamecast, "sessionToAgentId") as Map<string, string>;
  sessionToAgentId.set(sessionId, agentId);
}

function getMethod<Args extends unknown[], Result>(
  flamecast: Flamecast,
  name: string,
): (...args: Args) => Result {
  const method = Reflect.get(flamecast, name);
  if (typeof method !== "function") {
    throw new Error(`Expected ${name} to be a function`);
  }
  return method.bind(flamecast) as (...args: Args) => Result;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

test("builds filesystem snapshots, previews files, and enforces workspace file access", async () => {
  const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-fs-"));
  const outsideRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-outside-"));

  try {
    await mkdir(path.join(workspaceRoot, ".git"));
    await mkdir(path.join(workspaceRoot, "anchored-dir"));
    await mkdir(path.join(workspaceRoot, "ignored-dir"));
    await mkdir(path.join(workspaceRoot, "nested"));
    await mkdir(path.join(workspaceRoot, "nested", "anchored-subdir"));
    await mkdir(path.join(workspaceRoot, "nested", "ignored-subdir"));

    await writeFile(
      path.join(workspaceRoot, ".gitignore"),
      [
        "# comment",
        "",
        "!",
        "/",
        "ignored.txt",
        "*.log",
        "!keep.log",
        "**/secret.txt",
        "ignored-dir/",
        "/anchored-dir/",
        "/nested/anchored-subdir/",
        "/nested/exact.md",
        "nested/ignored-subdir/",
        "/root-only.txt",
        "\\#literal.txt",
        "\\!bang.txt",
        "nested/?.md",
      ].join("\n"),
    );
    await writeFile(path.join(workspaceRoot, "visible.txt"), "visible");
    await writeFile(path.join(workspaceRoot, "ignored.txt"), "ignored");
    await writeFile(path.join(workspaceRoot, "keep.log"), "keep");
    await writeFile(path.join(workspaceRoot, "debug.log"), "debug");
    await writeFile(path.join(workspaceRoot, "root-only.txt"), "root");
    await writeFile(path.join(workspaceRoot, "#literal.txt"), "literal");
    await writeFile(path.join(workspaceRoot, "!bang.txt"), "bang");
    await writeFile(path.join(workspaceRoot, "nested", "a.md"), "single");
    await writeFile(path.join(workspaceRoot, "nested", "ab.md"), "double");
    await writeFile(path.join(workspaceRoot, "nested", "anchored-subdir", "inside.txt"), "inside");
    await writeFile(path.join(workspaceRoot, "nested", "exact.md"), "exact");
    await writeFile(path.join(workspaceRoot, "nested", "ignored-subdir", "note.txt"), "note");
    await writeFile(path.join(workspaceRoot, "nested", "secret.txt"), "secret");
    await writeFile(path.join(workspaceRoot, "anchored-dir", "inside.txt"), "inside");
    execFileSync("mkfifo", [path.join(workspaceRoot, "named-pipe")]);

    const previewContent = "x".repeat(21_000);
    await writeFile(path.join(workspaceRoot, "preview.txt"), previewContent);

    const outsideFile = path.join(outsideRoot, "outside.txt");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, path.join(workspaceRoot, "linked-outside.txt"));

    const flamecast = new Flamecast({ storage: "memory" });
    const storage = attachStorage(flamecast);
    const agentId = "agent-1";
    const sessionId = "session-1";
    const managed = createManagedAgent(agentId);

    await storage.createAgent(createAgentMeta(agentId));
    await storage.createSession(createSessionMeta(sessionId, agentId, workspaceRoot));
    attachAgent(flamecast, managed);
    attachSession(flamecast, sessionId, agentId);

    const session = await flamecast.getSession(agentId, sessionId, { includeFileSystem: true });
    const fileSystemEntries = session.fileSystem?.entries.map((entry) => entry.path) ?? [];

    expect(fileSystemEntries).toContain("visible.txt");
    expect(fileSystemEntries).toContain("keep.log");
    expect(fileSystemEntries).toContain("nested");
    expect(fileSystemEntries).toContain("nested/ab.md");
    expect(fileSystemEntries).toContain("named-pipe");
    expect(fileSystemEntries).not.toContain(".git");
    expect(fileSystemEntries).not.toContain("ignored.txt");
    expect(fileSystemEntries).not.toContain("#literal.txt");
    expect(fileSystemEntries).not.toContain("!bang.txt");
    expect(fileSystemEntries).not.toContain("anchored-dir");
    expect(fileSystemEntries).not.toContain("debug.log");
    expect(fileSystemEntries).not.toContain("ignored-dir");
    expect(fileSystemEntries).not.toContain("root-only.txt");
    expect(fileSystemEntries).not.toContain("nested/a.md");
    expect(fileSystemEntries).not.toContain("nested/anchored-subdir");
    expect(fileSystemEntries).not.toContain("nested/exact.md");
    expect(fileSystemEntries).not.toContain("nested/ignored-subdir");
    expect(fileSystemEntries).not.toContain("nested/secret.txt");

    const allFilesSession = await flamecast.getSession(agentId, sessionId, {
      includeFileSystem: true,
      showAllFiles: true,
    });
    const allEntries = allFilesSession.fileSystem?.entries.map((entry) => entry.path) ?? [];
    expect(allEntries).toContain(".git");
    expect(allEntries).toContain("ignored.txt");
    expect(allEntries).toContain("#literal.txt");
    expect(allEntries).toContain("!bang.txt");
    expect(allEntries).toContain("anchored-dir");
    expect(allEntries).toContain("debug.log");
    expect(allEntries).toContain("ignored-dir");
    expect(allEntries).toContain("nested/anchored-subdir");
    expect(allEntries).toContain("nested/exact.md");
    expect(allEntries).toContain("nested/ignored-subdir");
    expect(allEntries).toContain("nested/secret.txt");

    const preview = await flamecast.getFilePreview(agentId, sessionId, "preview.txt");
    expect(preview.path).toBe("preview.txt");
    expect(preview.content).toHaveLength(20_000);
    expect(preview.truncated).toBe(true);

    const resolvePreviewPath = getMethod<[string, string], Promise<string>>(
      flamecast,
      "resolvePreviewPath",
    );
    await expect(resolvePreviewPath(workspaceRoot, outsideFile)).rejects.toThrow(
      `File preview paths must be relative: "${outsideFile}"`,
    );
    await expect(resolvePreviewPath(workspaceRoot, "linked-outside.txt")).rejects.toThrow(
      'Path "linked-outside.txt" is outside workspace root',
    );

    const resolveSessionFilePath = getMethod<[string, string], Promise<string>>(
      flamecast,
      "resolveSessionFilePath",
    );
    await expect(resolveSessionFilePath(sessionId, "visible.txt")).rejects.toThrow(
      'File paths must be absolute: "visible.txt"',
    );
    await expect(resolveSessionFilePath(sessionId, outsideFile)).rejects.toThrow(
      `Path "${outsideFile}" is outside workspace root`,
    );

    const resolveSessionWritePath = getMethod<[string, string], Promise<string>>(
      flamecast,
      "resolveSessionWritePath",
    );
    await expect(resolveSessionWritePath(sessionId, "visible.txt")).rejects.toThrow(
      'File paths must be absolute: "visible.txt"',
    );
    await expect(resolveSessionWritePath(sessionId, outsideFile)).rejects.toThrow(
      `Path "${outsideFile}" is outside workspace root`,
    );

    const createDownstreamClient = getMethod<[ManagedAgentLike], acp.Client>(
      flamecast,
      "createDownstreamClient",
    );
    const client = createDownstreamClient(managed);
    const readResponse = await client.readTextFile!({
      sessionId,
      path: path.join(workspaceRoot, "preview.txt"),
      line: 0,
      limit: 1,
    });
    expect(readResponse).toEqual({ content: previewContent });

    const writablePath = path.join(workspaceRoot, "written.txt");
    await expect(
      client.writeTextFile!({
        sessionId,
        path: writablePath,
        content: "written",
      }),
    ).resolves.toEqual({});
    await expect(readFile(writablePath, "utf8")).resolves.toBe("written");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("builds snapshots when .gitignore is missing", async () => {
  const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-no-ignore-"));

  try {
    await mkdir(path.join(workspaceRoot, ".git"));
    await writeFile(path.join(workspaceRoot, "visible.txt"), "visible");

    const flamecast = new Flamecast({ storage: "memory" });
    const buildFileSystemSnapshot = getMethod<
      [string, { showAllFiles?: boolean }?],
      Promise<{ entries: Array<{ path: string }> }>
    >(flamecast, "buildFileSystemSnapshot");
    const snapshot = await buildFileSystemSnapshot(workspaceRoot);
    const entries = snapshot.entries.map((entry) => entry.path);

    expect(entries).toContain("visible.txt");
    expect(entries).not.toContain(".git");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("treats ENOTDIR gitignore read errors like a missing .gitignore", async () => {
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.doMock("node:fs/promises", () => ({
    ...actualFs,
    readFile: vi.fn(async (filePath: string, ...args: unknown[]) => {
      if (filePath.endsWith(".gitignore")) {
        const error = new Error("not a directory") as Error & { code?: string };
        error.code = "ENOTDIR";
        throw error;
      }
      return actualFs.readFile(filePath, ...(args as Parameters<typeof actualFs.readFile>[1][]));
    }),
  }));

  const { Flamecast: MockedFlamecast } = await import(
    "../src/flamecast/index.ts?gitignore-enotdir"
  );
  const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-enotdir-"));

  try {
    await mkdir(path.join(workspaceRoot, ".git"));
    await writeFile(path.join(workspaceRoot, "visible.txt"), "visible");

    const flamecast = new MockedFlamecast({ storage: "memory" });
    const buildFileSystemSnapshot = getMethod<
      [string, { showAllFiles?: boolean }?],
      Promise<{ entries: Array<{ path: string }> }>
    >(flamecast, "buildFileSystemSnapshot");
    const snapshot = await buildFileSystemSnapshot(workspaceRoot);
    const entries = snapshot.entries.map((entry) => entry.path);

    expect(entries).toContain("visible.txt");
    expect(entries).not.toContain(".git");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("rethrows unexpected gitignore read errors", async () => {
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.doMock("node:fs/promises", () => ({
    ...actualFs,
    readFile: vi.fn(async (filePath: string, ...args: unknown[]) => {
      if (filePath.endsWith(".gitignore")) {
        throw new Error("boom");
      }
      return actualFs.readFile(filePath, ...(args as Parameters<typeof actualFs.readFile>[1][]));
    }),
  }));

  const { Flamecast: MockedFlamecast } = await import("../src/flamecast/index.ts?gitignore-error");
  const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-error-"));

  try {
    const flamecast = new MockedFlamecast({ storage: "memory" });
    const buildFileSystemSnapshot = getMethod<
      [string, { showAllFiles?: boolean }?],
      Promise<{ entries: Array<{ path: string }> }>
    >(flamecast, "buildFileSystemSnapshot");
    await expect(buildFileSystemSnapshot(workspaceRoot)).rejects.toThrow("boom");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
