import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DockerRuntime } from "../src/index.js";

function createRunningContainer(options?: {
  onExec?: (cmd: string[]) => { stdout: string; stderr?: string; exitCode?: number };
}) {
  const demuxQueue: Array<{ stdout: string; stderr: string }> = [];
  const execCalls: string[][] = [];
  const putArchiveCalls: Array<{ file: string | Buffer | NodeJS.ReadableStream; path: string }> =
    [];

  return {
    id: "container-1",
    async inspect() {
      return {
        Config: {
          WorkingDir: "/workspace",
        },
        State: { Running: true, Paused: false, ExitCode: 0 },
        NetworkSettings: {
          Ports: {
            "9000/tcp": [{ HostPort: "49100" }],
          },
        },
      };
    },
    async start() {},
    async unpause() {},
    async pause() {},
    async kill() {},
    async remove() {},
    async logs() {
      return Buffer.from("");
    },
    async putArchive(file: string | Buffer | NodeJS.ReadableStream, opts: { path: string }) {
      putArchiveCalls.push({ file, path: opts.path });
      return new PassThrough();
    },
    async exec(opts: {
      Cmd: string[];
      Env?: string[];
      AttachStdout: boolean;
      AttachStderr: boolean;
    }) {
      execCalls.push(opts.Cmd);
      const output = options?.onExec?.(opts.Cmd) ?? { stdout: "", stderr: "", exitCode: 0 };
      demuxQueue.push({ stdout: output.stdout, stderr: output.stderr ?? "" });
      return {
        async inspect() {
          return { ExitCode: output.exitCode ?? 0 };
        },
        async start() {
          const stream = new PassThrough();
          setTimeout(() => {
            stream.push(null);
            stream.emit("end");
          }, 0);
          return stream;
        },
      };
    },
    demuxQueue,
    execCalls,
    putArchiveCalls,
  };
}

function createDockerStub(
  container = createRunningContainer(),
  options?: { listContainers?: Array<{ Id: string; Labels?: Record<string, string> }> },
) {
  const createContainerCalls: Array<{
    HostConfig?: { Binds?: string[] };
    WorkingDir?: string;
  }> = [];

  return {
    createContainerCalls,
    container,
    docker: {
      async createContainer(opts: { HostConfig?: { Binds?: string[] }; WorkingDir?: string }) {
        createContainerCalls.push(opts);
        return container;
      },
      getContainer() {
        return container;
      },
      getImage() {
        return {
          async inspect() {
            return {};
          },
        };
      },
      async listContainers(_opts: { all: boolean }) {
        return (
          options?.listContainers ?? [
            { Id: "container-1", Labels: { "flamecast.instance": "runtime-1" } },
          ]
        );
      },
      async pull() {
        return new PassThrough();
      },
      modem: {
        demuxStream(
          _stream: NodeJS.ReadableStream,
          stdout: NodeJS.WritableStream,
          stderr: NodeJS.WritableStream,
        ) {
          const output = container.demuxQueue.shift() ?? { stdout: "", stderr: "" };
          stdout.write(output.stdout);
          stderr.write(output.stderr);
          stdout.end();
          stderr.end();
        },
        followProgress(_stream: NodeJS.ReadableStream, onFinished: (err: Error | null) => void) {
          onFinished(null);
        },
      },
    },
  };
}

let tempDirToCleanup: string | null = null;
let previousSessionHostBinary: string | undefined;

afterEach(() => {
  if (tempDirToCleanup) {
    rmSync(tempDirToCleanup, { recursive: true, force: true });
    tempDirToCleanup = null;
  }

  if (previousSessionHostBinary === undefined) {
    delete process.env.SESSION_HOST_BINARY;
  } else {
    process.env.SESSION_HOST_BINARY = previousSessionHostBinary;
  }
});

describe("DockerRuntime", () => {
  it("uploads session-host into the container without workspace bind mounts", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "flamecast-runtime-docker-"));
    tempDirToCleanup = tempDir;
    const sessionHostBinary = join(tempDir, "session-host");
    writeFileSync(sessionHostBinary, "binary");
    previousSessionHostBinary = process.env.SESSION_HOST_BINARY;
    process.env.SESSION_HOST_BINARY = sessionHostBinary;

    const container = createRunningContainer();
    const { docker, createContainerCalls } = createDockerStub(container, { listContainers: [] });
    const runtime = new DockerRuntime({ docker });

    await runtime.start("runtime-1");

    expect(createContainerCalls).toHaveLength(1);
    expect(createContainerCalls[0]?.HostConfig?.Binds).toBeUndefined();
    expect(createContainerCalls[0]?.WorkingDir).toBe("/workspace");
    expect(container.putArchiveCalls).toHaveLength(1);
    expect(container.putArchiveCalls[0]?.path).toBe("/usr/local/bin");
    expect(Buffer.isBuffer(container.putArchiveCalls[0]?.file)).toBe(true);
    expect(container.execCalls).toContainEqual([
      "sh",
      "-lc",
      "mkdir -p '/workspace' && chmod +x '/usr/local/bin/session-host'",
    ]);
  });

  it("resolves a running instance directly from Docker labels", async () => {
    const { docker } = createDockerStub();
    const runtime = new DockerRuntime({ docker });

    await expect(runtime.getInstanceStatus("runtime-1")).resolves.toBe("running");
  });

  it("returns a filesystem snapshot for a labeled container without tracked state", async () => {
    const container = createRunningContainer({
      onExec(cmd) {
        expect(cmd[0]).toBe("sh");
        expect(cmd[1]).toBe("-lc");
        expect(cmd[2]).toContain("find '/workspace' -mindepth 1 -printf");
        return {
          stdout: "d\tsrc\nf\tsrc/index.ts\n",
        };
      },
    });
    const { docker } = createDockerStub(container);
    const runtime = new DockerRuntime({ docker });

    const response = await runtime.fetchInstance(
      "runtime-1",
      new Request("http://host/fs/snapshot?showAllFiles=true", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      root: "/workspace",
      entries: [
        { path: "src", type: "directory" },
        { path: "src/index.ts", type: "file" },
      ],
      truncated: false,
      maxEntries: 10_000,
    });
  });
});
