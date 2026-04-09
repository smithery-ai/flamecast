import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime } from "../src/flamecast/runtime-node.js";

/** Start a simple HTTP server that records incoming requests and responds. */
function startMockServer(
  handler: (req: { method: string; url: string; body: string }) => { status: number; body: string },
): Promise<{
  url: string;
  server: Server;
  requests: Array<{ method: string; url: string; body: string }>;
}> {
  return new Promise((resolve) => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const entry = { method: req.method ?? "GET", url: req.url ?? "/", body };
        requests.push(entry);
        const result = handler(entry);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(result.body);
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://localhost:${port}`, server, requests });
    });
  });
}

describe("NodeRuntime", () => {
  const originalCwd = process.cwd();
  let serverToCleanup: Server | null = null;
  let tempDirToCleanup: string | null = null;

  afterEach(async () => {
    if (serverToCleanup) {
      serverToCleanup.close();
      serverToCleanup = null;
    }
    process.chdir(originalCwd);
    if (tempDirToCleanup) {
      await rm(tempDirToCleanup, { recursive: true, force: true });
      tempDirToCleanup = null;
    }
  });

  it("forwards HTTP requests to /sessions/:sessionId/:path", async () => {
    const { url, server, requests } = await startMockServer(() => ({
      status: 200,
      body: JSON.stringify({ ok: true }),
    }));
    serverToCleanup = server;

    const runtime = new NodeRuntime(url);
    const requestBody = JSON.stringify({ command: "echo", args: ["hi"], workspace: "." });

    const response = await runtime.fetchSession(
      "abc",
      new Request("http://host/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      }),
    );

    expect(response.status).toBe(200);
    expect(requests.length).toBe(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("/sessions/abc/start");
    expect(requests[0].body).toBe(requestBody);
  });

  it("preserves upstream session URLs when /start already returns them", async () => {
    const upstreamBody = {
      acpSessionId: "abc",
      hostUrl: "http://localhost:9999/sessions/abc",
      websocketUrl: "ws://localhost:9999/sessions/abc",
    };
    const { url, server } = await startMockServer(() => ({
      status: 200,
      body: JSON.stringify(upstreamBody),
    }));
    serverToCleanup = server;

    const runtime = new NodeRuntime(url);
    const response = await runtime.fetchSession(
      "abc",
      new Request("http://host/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo", args: ["hi"], workspace: "." }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(upstreamBody);
  });

  it("propagates error status codes from upstream", async () => {
    const { url, server } = await startMockServer(() => ({
      status: 500,
      body: JSON.stringify({ error: "internal failure" }),
    }));
    serverToCleanup = server;

    const runtime = new NodeRuntime(url);
    const response = await runtime.fetchSession(
      "xyz",
      new Request("http://host/start", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json).toEqual({ error: "internal failure" });
  });

  it("preserves query parameters when proxying session requests", async () => {
    const { url, server, requests } = await startMockServer(() => ({
      status: 200,
      body: JSON.stringify({ ok: true }),
    }));
    serverToCleanup = server;

    const runtime = new NodeRuntime(url);

    const response = await runtime.fetchSession(
      "abc",
      new Request("http://host/files?path=agent.ts", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(200);
    expect(requests.length).toBe(1);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe("/sessions/abc/files?path=agent.ts");
    expect(requests[0].body).toBe("");
  });

  it("forwards runtime-instance requests without a session prefix", async () => {
    const { url, server, requests } = await startMockServer(() => ({
      status: 200,
      body: JSON.stringify({ ok: true }),
    }));
    serverToCleanup = server;

    const runtime = new NodeRuntime(url);

    const response = await runtime.fetchInstance?.(
      "local",
      new Request("http://host/fs/snapshot?showAllFiles=true", { method: "GET" }),
    );

    expect(response?.status).toBe(200);
    expect(requests.length).toBe(1);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe("/fs/snapshot?showAllFiles=true");
    expect(requests[0].body).toBe("");
  });

  it("serves runtime filesystem snapshots without requiring an active session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "node-runtime-"));
    tempDirToCleanup = workspace;
    process.chdir(workspace);

    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "ignored"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "ignored/\nsecret.txt\n");
    await writeFile(join(workspace, "src", "index.ts"), "export const answer = 42;\n");
    await writeFile(join(workspace, "ignored", "keep.txt"), "hidden\n");
    await writeFile(join(workspace, "secret.txt"), "secret\n");

    const runtime = new NodeRuntime();

    const visibleResponse = await runtime.fetchInstance(
      "local",
      new Request("http://host/fs/snapshot", { method: "GET" }),
    );

    expect(visibleResponse.status).toBe(200);
    const visibleSnapshot: { root: string; path: string; entries: Array<{ path: string }> } =
      await visibleResponse.json();
    expect(visibleSnapshot.root).toBe(process.cwd());
    expect(visibleSnapshot.path).toBe(process.cwd());
    // Single-level listing: only direct children, names only
    // Gitignored entries and dotfiles are hidden by default
    expect(visibleSnapshot.entries.map((entry) => entry.path)).not.toContain(".gitignore");
    expect(visibleSnapshot.entries.map((entry) => entry.path)).toContain("src");
    expect(visibleSnapshot.entries.map((entry) => entry.path)).not.toContain("src/index.ts");
    expect(visibleSnapshot.entries.map((entry) => entry.path)).not.toContain("ignored");
    expect(visibleSnapshot.entries.map((entry) => entry.path)).not.toContain("secret.txt");

    const allFilesResponse = await runtime.fetchInstance(
      "local",
      new Request("http://host/fs/snapshot?showAllFiles=true", { method: "GET" }),
    );

    expect(allFilesResponse.status).toBe(200);
    const fullSnapshot: { entries: Array<{ path: string }> } = await allFilesResponse.json();
    // With showAllFiles, dotfiles, ignored entries all visible
    expect(fullSnapshot.entries.map((entry) => entry.path)).toContain(".gitignore");
    expect(fullSnapshot.entries.map((entry) => entry.path)).toContain("ignored");
    expect(fullSnapshot.entries.map((entry) => entry.path)).toContain("secret.txt");
    // But nested paths are NOT returned (single-level listing)
    expect(fullSnapshot.entries.map((entry) => entry.path)).not.toContain("ignored/keep.txt");
  });

  it("reads runtime file previews from the local workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "node-runtime-"));
    tempDirToCleanup = workspace;
    process.chdir(workspace);

    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "console.log('local runtime');\n");

    const runtime = new NodeRuntime();
    const response = await runtime.fetchInstance(
      "local",
      new Request("http://host/files?path=src%2Findex.ts", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "src/index.ts",
      content: "console.log('local runtime');\n",
      truncated: false,
      maxChars: 100_000,
    });
  });
});
