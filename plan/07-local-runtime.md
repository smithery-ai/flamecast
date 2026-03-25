# 2.2 — LocalRuntime

**Goal:** Implement `LocalRuntime` — spawns SessionHost child processes via `child_process.spawn`. Absorbs the logic from `router.ts`.

**Depends on:** 2.1 (Runtime interface, for type conformance)

## What to do

Create `packages/flamecast/src/flamecast/runtimes/local.ts`:

```typescript
export class LocalRuntime implements Runtime<{}> {
  private readonly hosts = new Map<string, { process: ChildProcess; port: number }>();

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    let host = this.hosts.get(sessionId);
    if (!host && new URL(request.url).pathname.endsWith("/start")) {
      host = await this.spawnHost(sessionId);
      this.hosts.set(sessionId, host);
    }
    if (!host) return new Response("Session not found", { status: 404 });

    // Forward to session host's HTTP server
    const url = new URL(request.url);
    url.hostname = "localhost";
    url.port = String(host.port);
    return fetch(url.toString(), request);
  }

  private async spawnHost(sessionId: string): Promise<{ process: ChildProcess; port: number }> {
    // Spawn session host with SESSION_HOST_PORT=0 (auto-assign)
    // Wait for "listening on port X" on stdout
    // Return process handle + port
  }

  async dispose(): Promise<void> {
    for (const [, host] of this.hosts) host.process.kill();
    this.hosts.clear();
  }

  /** Sidecar mode: start HTTP server for serverless control planes. */
  async listen(port?: number): Promise<string> {
    // Start a thin HTTP server that routes /sessions/:id/* to fetchSession()
    // Return URL (e.g., "http://localhost:PORT")
  }
}
```

Two modes:

- **In-process** (`apps/server`): used directly, no HTTP intermediary
- **Sidecar** (`apps/worker` via Alchemy): `.listen()` starts HTTP, Worker uses `RemoteRuntime` to reach it

Port the session host spawning logic from `packages/session-host/src/router.ts`. The router's HTTP routing becomes `LocalRuntime.listen()`.

Delete `packages/session-host/src/router.ts`.

## Files

- **New:** `packages/flamecast/src/flamecast/runtimes/local.ts`
- **Delete:** `packages/session-host/src/router.ts`

## Test Coverage

Integration tests (spin up real child processes, no mocks):

- **Spawn lifecycle:** `fetchSession(id, POST /start)` returns `{ hostUrl, websocketUrl }` with 200 status. `GET /health` on `hostUrl` returns 200. `fetchSession(id, POST /terminate)` kills the host process (verify process exit).
- **Port isolation:** Start two sessions. Each gets a different port. Requests to each session are routed to the correct host process.
- **Dispose cleanup:** Start 3 sessions. Call `dispose()`. All child processes are killed, no orphan processes remain.
- **Sidecar mode:** Call `listen()`. HTTP server starts. Requests forwarded correctly through HTTP layer. Same spawn/terminate lifecycle works through the HTTP interface.

## Acceptance criteria

- `LocalRuntime` spawns a session host child process on `/start`
- Subsequent requests forwarded to the session host's port
- `/terminate` kills the session host process
- `.dispose()` kills all session hosts
- `.listen()` starts an HTTP server that delegates to `fetchSession()`
