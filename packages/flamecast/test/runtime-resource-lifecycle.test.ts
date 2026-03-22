import { describe, expect, it } from "vitest";
import { Resource } from "alchemy";
import type { Context } from "alchemy";
import { createServer } from "node:net";
import {
  createRuntimeProvider,
  createDockerProvisioner,
  resolveRuntimeProviders,
  resolveDockerBuildContext,
  waitForAcp,
} from "../src/flamecast/runtime-provider.js";
import type { RuntimeProvisioner } from "../src/flamecast/runtime-provider.js";

// ---------------------------------------------------------------------------
// Test resource — a lightweight alchemy resource that records lifecycle events
// without provisioning real infrastructure.
// ---------------------------------------------------------------------------

type RuntimeResourceProps = { sessionId: string; kind: "sandbox" | "image" };
interface RuntimeResource extends RuntimeResourceProps {
  createdAt: number;
}

const lifecycleLog: { event: "create" | "destroy"; id: string; sessionId: string }[] = [];

const TestRuntimeResource = Resource(
  "test::RuntimeResource",
  async function (
    this: Context<RuntimeResource, RuntimeResourceProps>,
    id: string,
    props: RuntimeResourceProps,
  ): Promise<RuntimeResource> {
    if (this.phase === "delete") {
      lifecycleLog.push({ event: "destroy", id, sessionId: props.sessionId });
      return this.destroy();
    }

    lifecycleLog.push({ event: "create", id, sessionId: props.sessionId });
    return this.create({
      sessionId: props.sessionId,
      kind: props.kind,
      createdAt: Date.now(),
    });
  },
);

// ---------------------------------------------------------------------------
// Test provisioner — creates test resources instead of docker containers.
// Conditionally creates "image" based on runtime.dockerfile, matching
// the docker provisioner's behavior.
// ---------------------------------------------------------------------------

const testProvisioner: RuntimeProvisioner = async ({ runtime, sessionId }) => {
  if (runtime.dockerfile) {
    await TestRuntimeResource("image", { sessionId, kind: "image" });
  }

  await TestRuntimeResource("sandbox", { sessionId, kind: "sandbox" });

  return {
    transport: { input: new WritableStream(), output: new ReadableStream() },
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventsForSession(sessionId: string) {
  return lifecycleLog.filter((e) => e.sessionId === sessionId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runtime resource lifecycle", () => {
  const provider = createRuntimeProvider(testProvisioner);

  it("creates image and sandbox resources when dockerfile is provided", async () => {
    const before = lifecycleLog.length;
    const sessionId = "test-with-dockerfile";

    const started = await provider.start({
      sessionId,
      spawn: { command: "echo", args: [] },
      runtime: { provider: "test", dockerfile: "Dockerfile" },
    });

    try {
      const creates = lifecycleLog.slice(before).filter((e) => e.event === "create");
      expect(creates).toHaveLength(2);
      expect(creates.map((e) => e.id)).toEqual(expect.arrayContaining(["image", "sandbox"]));
    } finally {
      await started.terminate();
    }
  });

  it("creates only sandbox when no dockerfile is provided", async () => {
    const before = lifecycleLog.length;
    const sessionId = "test-no-dockerfile";

    const started = await provider.start({
      sessionId,
      spawn: { command: "echo", args: [] },
      runtime: { provider: "test", image: "some-image" },
    });

    try {
      const creates = lifecycleLog.slice(before).filter((e) => e.event === "create");
      expect(creates).toHaveLength(1);
      expect(creates[0].id).toBe("sandbox");
    } finally {
      await started.terminate();
    }
  });

  it("destroys all resources in the session scope on terminate", async () => {
    const sessionId = "test-destroy";

    const started = await provider.start({
      sessionId,
      spawn: { command: "echo", args: [] },
      runtime: { provider: "test", dockerfile: "Dockerfile" },
    });

    const before = lifecycleLog.length;
    await started.terminate();

    const destroys = lifecycleLog.slice(before).filter((e) => e.event === "destroy");
    expect(destroys).toHaveLength(2);
    expect(destroys.every((e) => e.sessionId === sessionId)).toBe(true);
  });

  it("terminating one session does not affect another's resources", async () => {
    const sessionA = "test-isolation-a";
    const sessionB = "test-isolation-b";

    const startedA = await provider.start({
      sessionId: sessionA,
      spawn: { command: "echo", args: [] },
      runtime: { provider: "test", dockerfile: "Dockerfile" },
    });

    const startedB = await provider.start({
      sessionId: sessionB,
      spawn: { command: "echo", args: [] },
      runtime: { provider: "test", dockerfile: "Dockerfile" },
    });

    const before = lifecycleLog.length;
    await startedB.terminate();

    const destroys = lifecycleLog.slice(before).filter((e) => e.event === "destroy");
    expect(destroys.every((e) => e.sessionId === sessionB)).toBe(true);
    expect(destroys.some((e) => e.sessionId === sessionA)).toBe(false);

    const beforeA = lifecycleLog.length;
    await startedA.terminate();
    const aDestroys = lifecycleLog.slice(beforeA).filter((e) => e.event === "destroy");
    expect(aDestroys).toHaveLength(2);
    expect(aDestroys.every((e) => e.sessionId === sessionA)).toBe(true);
  });

  it("each session gets its own named scope", async () => {
    const sessionA = "test-namespace-a";
    const sessionB = "test-namespace-b";

    const startedA = await provider.start({
      sessionId: sessionA,
      spawn: { command: "echo", args: [] },
      runtime: { provider: "test", dockerfile: "Dockerfile" },
    });

    const startedB = await provider.start({
      sessionId: sessionB,
      spawn: { command: "echo", args: [] },
      runtime: { provider: "test", dockerfile: "Dockerfile" },
    });

    try {
      const aCreates = eventsForSession(sessionA).filter((e) => e.event === "create");
      const bCreates = eventsForSession(sessionB).filter((e) => e.event === "create");

      expect(aCreates.map((e) => e.id)).toEqual(bCreates.map((e) => e.id));
      expect(aCreates.every((e) => e.sessionId === sessionA)).toBe(true);
      expect(bCreates.every((e) => e.sessionId === sessionB)).toBe(true);
    } finally {
      await startedA.terminate();
      await startedB.terminate();
    }
  });
});

describe("runtime provider registry", () => {
  it("resolveRuntimeProviders merges custom providers with builtins", () => {
    const custom = createRuntimeProvider(testProvisioner);
    const providers = resolveRuntimeProviders({ custom });
    expect(providers).toMatchObject({
      local: expect.any(Object),
      docker: expect.any(Object),
      custom: expect.any(Object),
    });
  });

  it("custom providers override builtins with the same key", () => {
    const custom = createRuntimeProvider(testProvisioner);
    const providers = resolveRuntimeProviders({ local: custom });
    expect(providers.local).toBe(custom);
  });
});

describe("resolveDockerBuildContext", () => {
  it("resolves parent directory when dockerfile is in a docker/ directory", () => {
    const result = resolveDockerBuildContext("docker/Dockerfile");
    expect(result).not.toContain("docker");
  });

  it("resolves the dockerfile directory for non-docker paths", () => {
    const result = resolveDockerBuildContext("build/Dockerfile");
    expect(result).toContain("build");
  });
});

describe("waitForAcp", () => {
  it("resolves when the server responds to the ACP handshake", async () => {
    const server = createServer((socket) => {
      socket.on("data", () => {
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }) + "\n");
        socket.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected address");

    try {
      await waitForAcp("127.0.0.1", address.port, { timeoutMs: 5_000 });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("retries on connection refused then succeeds", async () => {
    const server = createServer((socket) => {
      socket.on("data", () => {
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }) + "\n");
        socket.end();
      });
    });

    // Start server after a delay to simulate initial connection refused
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        s.close(() => resolve(p));
      });
    });

    setTimeout(() => {
      server.listen(port, "127.0.0.1");
    }, 100);

    try {
      await waitForAcp("127.0.0.1", port, {
        timeoutMs: 5_000,
        retryDelayMs: 50,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("times out when the server never responds", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        s.close(() => resolve(p));
      });
    });

    await expect(
      waitForAcp("127.0.0.1", port, { timeoutMs: 100, retryDelayMs: 20 }),
    ).rejects.toThrow(`ACP agent not ready on 127.0.0.1:${port} after 100ms`);
  });
});

describe("createDockerProvisioner", () => {
  it("throws when no image is provided", async () => {
    const provisioner = createDockerProvisioner();
    await expect(
      provisioner({
        runtime: { provider: "docker" },
        spawn: { command: "echo", args: [] },
        sessionId: "test-no-image",
      }),
    ).rejects.toThrow('Docker runtime requires an "image" value');
  });
});
