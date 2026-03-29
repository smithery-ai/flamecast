/**
 * Regression tests for bugs found during the PR #61 rollout.
 * Each test corresponds to a specific production failure.
 */
import { describe, it, expect } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { InProcessSessionHost } from "./fixtures/in-process-session-host.js";
import { createClient, createTestStorage } from "./fixtures/test-helpers.js";
import type { Runtime } from "@flamecast/protocol/runtime";

/**
 * 1. ACP permission response shape
 *
 * Bug: session-host sent { optionId: "allow" } to ACP resolver but
 * ACP SDK expects { outcome: { outcome: "selected", optionId: "allow" } }.
 * Agent errored with "Cannot read properties of undefined (reading 'outcome')".
 */
describe("ACP permission response shape", () => {
  it("c.allow() returns optionId matching first allow_once option", async () => {
    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();

    let handlerResult: unknown = null;
    const flamecast = new Flamecast({
      storage,
      runtimes: { default: runtime },
      agentTemplates: [
        {
          id: "test",
          name: "Test",
          spawn: { command: "echo", args: [] },
          runtime: { provider: "default" },
        },
      ],
      onPermissionRequest: async (c) => {
        handlerResult = c.allow();
        return c.allow();
      },
    });

    const client = createClient(flamecast);
    const res = await client.agents.$post({ json: { agentTemplateId: "test" } });
    expect(res.status).toBe(201);
    const session = await res.json();

    const permissionEvent = {
      requestId: "perm-1",
      toolCallId: "tool-1",
      title: "Edit config.json",
      kind: "edit",
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    };

    const result = await flamecast.handlePermissionRequest(session.id, permissionEvent);

    // Handler was called and allow() returned the right optionId
    expect(result).toBeDefined();
    expect(result).toHaveProperty("optionId", "allow");

    // Verify allow() matched the allow_once option, not some other shape
    expect(handlerResult).toEqual({ optionId: "allow" });
  });
});

/**
 * 2. Multi-session isolation
 *
 * Bug: NodeRuntime pointed all sessions to one session-host process.
 * Second session got "Session already running" because the single
 * session-host only supports one session.
 */
describe("multi-session isolation", () => {
  it("two sessions on same runtime do not collide", async () => {
    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { default: runtime },
      agentTemplates: [
        {
          id: "test",
          name: "Test",
          spawn: { command: "echo", args: [] },
          runtime: { provider: "default" },
        },
      ],
    });

    const client = createClient(flamecast);

    // Create two sessions
    const res1 = await client.agents.$post({ json: { agentTemplateId: "test" } });
    expect(res1.status).toBe(201);
    const session1 = await res1.json();

    const res2 = await client.agents.$post({ json: { agentTemplateId: "test" } });
    expect(res2.status).toBe(201);
    const session2 = await res2.json();

    // Both should be active with different IDs
    expect(session1.id).not.toBe(session2.id);
    expect(session1.status).toBe("active");
    expect(session2.status).toBe("active");

    // Terminate one — the other should still be active
    const delRes = await client.agents[":agentId"].$delete({ param: { agentId: session1.id } });
    expect(delRes.status).toBe(200);

    const getRes = await client.agents[":agentId"].$get({ param: { agentId: session2.id } });
    expect(getRes.status).toBe(200);
    const s2 = await getRes.json();
    expect(s2.status).toBe("active");
  });

  it("three concurrent sessions all tracked independently", async () => {
    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { default: runtime },
      agentTemplates: [
        {
          id: "test",
          name: "Test",
          spawn: { command: "echo", args: [] },
          runtime: { provider: "default" },
        },
      ],
    });

    const client = createClient(flamecast);

    const sessions = await Promise.all(
      [1, 2, 3].map(async () => {
        const res = await client.agents.$post({ json: { agentTemplateId: "test" } });
        return res.json();
      }),
    );

    // All different IDs
    const ids = new Set(sessions.map((s) => s.id));
    expect(ids.size).toBe(3);

    // List shows all 3
    const listRes = await client.agents.$get();
    const list = await listRes.json();
    expect(list.length).toBe(3);

    // Runtime has all 3
    expect(runtime.getSessionIds().length).toBe(3);
  });
});

/**
 * 3. Template provider dispatch
 *
 * Bug: Docker templates dispatched to NodeRuntime instead of DockerRuntime
 * because the provider name wasn't matched correctly.
 */
describe("template provider dispatch", () => {
  it("template with provider 'docker' dispatches to docker runtime, not default", async () => {
    const defaultRuntime = new InProcessSessionHost();
    const dockerRuntime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: {
        default: defaultRuntime,
        docker: dockerRuntime,
      },
      agentTemplates: [
        {
          id: "local-agent",
          name: "Local",
          spawn: { command: "echo", args: [] },
          runtime: { provider: "default" },
        },
        {
          id: "docker-agent",
          name: "Docker",
          spawn: { command: "node", args: ["agent.js"] },
          runtime: { provider: "docker" },
        },
      ],
    });

    const client = createClient(flamecast);

    // Start local agent
    const localRes = await client.agents.$post({ json: { agentTemplateId: "local-agent" } });
    expect(localRes.status).toBe(201);

    // Start docker agent
    const dockerRes = await client.agents.$post({ json: { agentTemplateId: "docker-agent" } });
    expect(dockerRes.status).toBe(201);

    // Default runtime should have 1 session, docker runtime should have 1
    expect(defaultRuntime.getSessionIds().length).toBe(1);
    expect(dockerRuntime.getSessionIds().length).toBe(1);

    // They should not be mixed
    const localSession = defaultRuntime.getSessionIds()[0];
    const dockerSession = dockerRuntime.getSessionIds()[0];
    expect(localSession).not.toBe(dockerSession);
  });

  it("unknown provider returns clear error listing available runtimes", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { default: new InProcessSessionHost() },
      agentTemplates: [
        {
          id: "bad",
          name: "Bad",
          spawn: { command: "x", args: [] },
          runtime: { provider: "nonexistent" },
        },
      ],
    });

    const client = createClient(flamecast);
    const res = await client.agents.$post({ json: { agentTemplateId: "bad" } });
    expect(res.status).toBe(400);
    const body = await res.json();
    // oxlint-disable-next-line no-type-assertion/no-type-assertion
    const errorBody = body as { error: string };
    expect(errorBody.error).toMatch(/nonexistent/);
    expect(errorBody.error).toMatch(/default/);
  });
});

/**
 * 4. Workspace/cwd propagation
 *
 * Bug: process.cwd() returned apps/server/ (turbo runs from package dir),
 * so agent path packages/flamecast/src/flamecast/agent.ts resolved to
 * apps/server/packages/flamecast/... which doesn't exist.
 */
describe("workspace cwd propagation", () => {
  it("workspace from createSession body reaches the runtime /start request", async () => {
    let capturedWorkspace: string | undefined;

    const spyRuntime: Runtime = {
      async fetchSession(_sessionId: string, request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/start") && request.method === "POST") {
          const body = JSON.parse(await request.text());
          capturedWorkspace = body.workspace;
          return new Response(
            JSON.stringify({
              acpSessionId: "acp-1",
              hostUrl: "http://localhost:9999",
              websocketUrl: "ws://localhost:9999",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.pathname.endsWith("/terminate")) {
          return new Response("OK");
        }
        return new Response("OK");
      },
    };

    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { default: spyRuntime },
      agentTemplates: [
        {
          id: "test",
          name: "Test",
          spawn: { command: "echo", args: [] },
          runtime: { provider: "default" },
        },
      ],
    });

    const client = createClient(flamecast);
    const res = await client.agents.$post({
      json: { agentTemplateId: "test", cwd: "/my/custom/workspace" },
    });
    expect(res.status).toBe(201);

    // The workspace should be what we passed, not process.cwd()
    expect(capturedWorkspace).toBe("/my/custom/workspace");
  });

  it("default workspace is process.cwd() when not specified", async () => {
    let capturedWorkspace: string | undefined;

    const spyRuntime: Runtime = {
      async fetchSession(_sessionId: string, request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/start") && request.method === "POST") {
          const body = JSON.parse(await request.text());
          capturedWorkspace = body.workspace;
          return new Response(
            JSON.stringify({
              acpSessionId: "acp-1",
              hostUrl: "http://localhost:9999",
              websocketUrl: "ws://localhost:9999",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.pathname.endsWith("/terminate")) {
          return new Response("OK");
        }
        return new Response("OK");
      },
    };

    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { default: spyRuntime },
      agentTemplates: [
        {
          id: "test",
          name: "Test",
          spawn: { command: "echo", args: [] },
          runtime: { provider: "default" },
        },
      ],
    });

    const client = createClient(flamecast);
    const res = await client.agents.$post({ json: { agentTemplateId: "test" } });
    expect(res.status).toBe(201);

    // Should be process.cwd(), not "." or empty
    expect(capturedWorkspace).toBe(process.cwd());
    expect(capturedWorkspace).not.toBe(".");
    expect(capturedWorkspace).toBeTruthy();
  });
});
