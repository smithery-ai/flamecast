process.env.ALCHEMY_CI_STATE_STORE_CHECK = "false";

import { describe, expect, it } from "vitest";
import alchemy from "alchemy";
import { Resource } from "alchemy";
import type { Context } from "alchemy";
import type { RuntimeProvider } from "../src/flamecast/runtime-provider.js";

// ---------------------------------------------------------------------------
// Test resource — a lightweight alchemy resource that records lifecycle events
// without provisioning real infrastructure.
// ---------------------------------------------------------------------------

type RuntimeResourceProps = { sessionId: string; kind: "sandbox" | "image" };
interface RuntimeResource extends RuntimeResourceProps {
  createdAt: number;
  status: "running" | "destroyed";
}

/** Tracks every create/destroy across all test runs for assertions. */
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
      status: "running",
    });
  },
);

// ---------------------------------------------------------------------------
// Test runtime provider — mirrors the real docker provider's ensureApp() +
// alchemy.run() + alchemy.destroy(scope) pattern using TestRuntimeResource.
// ---------------------------------------------------------------------------

let resourceScope: Promise<import("alchemy").Scope> | undefined;

function createTestRuntimeProvider(): RuntimeProvider {
  return {
    async start({ sessionId }) {
      resourceScope ??= alchemy("flame-resources-test", { quiet: true, noTrack: true });
      const root = await resourceScope;

      return alchemy.run(`session-${sessionId}`, { parent: root }, async (scope) => {
        await TestRuntimeResource("image", {
          sessionId,
          kind: "image",
        });

        await TestRuntimeResource("sandbox", {
          sessionId,
          kind: "sandbox",
        });

        return {
          transport: { input: new WritableStream(), output: new ReadableStream() },
          terminate: async () => {
            await alchemy.destroy(scope).catch(() => undefined);
          },
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventsForSession(sessionId: string) {
  return lifecycleLog.filter((e) => e.sessionId === sessionId);
}

// ---------------------------------------------------------------------------
// Tests — exercise the provider start/terminate directly to verify that
// alchemy resources are created within the scope and properly destroyed.
// ---------------------------------------------------------------------------

describe("runtime resource lifecycle", () => {
  const provider = createTestRuntimeProvider();

  it("creates alchemy resources when a provider starts", async () => {
    const before = lifecycleLog.length;
    const sessionId = "test-create";

    const started = await provider.start({
      sessionId,
      spawn: { command: "echo", args: [] },
      runtime: { provider: "test" },
    });

    try {
      const creates = lifecycleLog.slice(before).filter((e) => e.event === "create");
      expect(creates).toHaveLength(2);
      expect(creates.map((e) => e.id)).toEqual(expect.arrayContaining(["image", "sandbox"]));
      // Resources are namespaced by session via the scope, not the resource ID
      expect(creates.every((e) => e.sessionId === sessionId)).toBe(true);
    } finally {
      await started.terminate();
    }
  });

  it("destroys all resources in the session scope on terminate", async () => {
    const sessionId = "test-destroy";

    const started = await provider.start({
      sessionId,
      spawn: { command: "echo", args: [] },
      runtime: { provider: "test" },
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
      runtime: { provider: "test" },
    });

    const startedB = await provider.start({
      sessionId: sessionB,
      spawn: { command: "echo", args: [] },
      runtime: { provider: "test" },
    });

    const before = lifecycleLog.length;
    await startedB.terminate();

    const destroys = lifecycleLog.slice(before).filter((e) => e.event === "destroy");

    // Only B's resources were destroyed
    expect(destroys.every((e) => e.sessionId === sessionB)).toBe(true);
    expect(destroys.some((e) => e.sessionId === sessionA)).toBe(false);

    // A can still be terminated independently
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
      runtime: { provider: "test" },
    });

    const startedB = await provider.start({
      sessionId: sessionB,
      spawn: { command: "echo", args: [] },
      runtime: { provider: "test" },
    });

    try {
      const aCreates = eventsForSession(sessionA).filter((e) => e.event === "create");
      const bCreates = eventsForSession(sessionB).filter((e) => e.event === "create");

      // Both sessions created the same resource IDs ("image", "sandbox")
      // but they're in different scopes so there's no collision
      expect(aCreates.map((e) => e.id)).toEqual(bCreates.map((e) => e.id));
      expect(aCreates.every((e) => e.sessionId === sessionA)).toBe(true);
      expect(bCreates.every((e) => e.sessionId === sessionB)).toBe(true);
    } finally {
      await startedA.terminate();
      await startedB.terminate();
    }
  });
});
