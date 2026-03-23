import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { buildFileSystemSnapshot } from "../src/flamecast/runtime-provider.js";
import { AcpBridge } from "../src/runtime/acp-bridge.js";
import { LocalRuntimeClient } from "../src/runtime/local.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";

type ManagedSessionLike = {
  id: string;
  workspaceRoot: string;
  bridge: any;
  terminate: () => Promise<void>;
  inFlightPromptId: string | null;
  promptQueue: Array<{ queueId: string; text: string; enqueuedAt: string }>;
};

function createMeta(id: string) {
  return {
    id,
    agentName: "Example agent",
    spawn: { command: "node", args: ["agent.js"] },
    startedAt: "2024-01-01T00:00:00.000Z",
    lastUpdatedAt: "2024-01-01T00:00:00.000Z",
    status: "active" as const,
    pendingPermission: null,
  };
}

function createMockBridge() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    initialize: vi.fn(),
    newSession: vi.fn(),
    prompt: vi.fn(),
    resolvePermission: vi.fn(),
    flush: vi.fn(async () => {}),
    isInitialized: false,
  });
}

function createManagedSession(id: string, workspaceRoot: string): ManagedSessionLike {
  return {
    id,
    workspaceRoot,
    bridge: createMockBridge(),
    terminate: vi.fn(async () => {}),
    lastFileSystemSnapshot: null,
    inFlightPromptId: null,
    promptQueue: [],
  };
}

function attachStorage(flamecast: Flamecast, storage = new MemoryFlamecastStorage()) {
  Reflect.set(flamecast, "storage", storage);
  Reflect.set(flamecast, "readyPromise", Promise.resolve());
  return storage;
}

function getRuntimeClient(flamecast: Flamecast): LocalRuntimeClient {
  // oxlint-disable-next-line no-type-assertion/no-type-assertion
  return Reflect.get(flamecast, "runtimeClient") as LocalRuntimeClient;
}

function getRuntimeMap(flamecast: Flamecast) {
  // oxlint-disable-next-line no-type-assertion/no-type-assertion
  return Reflect.get(getRuntimeClient(flamecast), "runtimes") as Map<string, ManagedSessionLike>;
}

function getMethod<Args extends unknown[], Result>(
  target: object,
  name: string,
): (...args: Args) => Result {
  const method = Reflect.get(target, name);
  if (typeof method !== "function") {
    throw new Error(`Expected ${name} to be a function`);
  }
  // oxlint-disable-next-line no-type-assertion/no-type-assertion
  return method.bind(target) as (...args: Args) => Result;
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

    // Test buildFileSystemSnapshot directly (no longer via Flamecast.getSession)
    const snapshot = await buildFileSystemSnapshot(workspaceRoot);
    const fileSystemEntries = snapshot.entries.map((entry) => entry.path);

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

    const allFilesSnapshot = await buildFileSystemSnapshot(workspaceRoot, { showAllFiles: true });
    const allEntries = allFilesSnapshot.entries.map((entry) => entry.path);
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

    const realBridge = new AcpBridge(
      { input: new TransformStream<Uint8Array, Uint8Array>().writable, output: new TransformStream<Uint8Array, Uint8Array>().readable },
      workspaceRoot,
    );
    const resolveAbsoluteReadPath = getMethod<[string], Promise<string>>(
      realBridge,
      "resolveAbsoluteReadPath",
    );
    await expect(resolveAbsoluteReadPath("visible.txt")).rejects.toThrow(
      'File paths must be absolute: "visible.txt"',
    );
    await expect(resolveAbsoluteReadPath(outsideFile)).rejects.toThrow(
      `Path "${outsideFile}" is outside workspace root`,
    );

    const resolveAbsoluteWritePath = getMethod<[string], Promise<string>>(
      realBridge,
      "resolveAbsoluteWritePath",
    );
    await expect(resolveAbsoluteWritePath("visible.txt")).rejects.toThrow(
      'File paths must be absolute: "visible.txt"',
    );
    await expect(resolveAbsoluteWritePath(outsideFile)).rejects.toThrow(
      `Path "${outsideFile}" is outside workspace root`,
    );

    const createClient = getMethod<[], ReturnType<typeof getMethod>>(
      realBridge,
      "createClient",
    );
    const client = createClient();
    const readResponse = await client.readTextFile({
      path: path.join(workspaceRoot, "preview.txt"),
      line: 0,
      limit: 1,
    });
    expect(readResponse).toEqual({ content: previewContent });

    const writablePath = path.join(workspaceRoot, "written.txt");
    await expect(
      client.writeTextFile({
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
    readFile: vi.fn(async (...args: Parameters<typeof actualFs.readFile>) => {
      const [filePath, ...rest] = args;
      if (filePath.endsWith(".gitignore")) {
        const error = Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
        throw error;
      }
      return actualFs.readFile(filePath, ...rest);
    }),
  }));

  const { buildFileSystemSnapshot: mockedBuild } =
    await import("../src/flamecast/runtime-provider.ts?gitignore-enotdir");
  const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-enotdir-"));

  try {
    await mkdir(path.join(workspaceRoot, ".git"));
    await writeFile(path.join(workspaceRoot, "visible.txt"), "visible");

    const snapshot = await mockedBuild(workspaceRoot);
    const entries = snapshot.entries.map((entry: { path: string }) => entry.path);

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
    readFile: vi.fn(async (...args: Parameters<typeof actualFs.readFile>) => {
      const [filePath, ...rest] = args;
      if (filePath.endsWith(".gitignore")) {
        throw new Error("boom");
      }
      return actualFs.readFile(filePath, ...rest);
    }),
  }));

  const { buildFileSystemSnapshot: mockedBuild } =
    await import("../src/flamecast/runtime-provider.ts?gitignore-error");
  const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-error-"));

  try {
    await expect(mockedBuild(workspaceRoot)).rejects.toThrow("boom");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
