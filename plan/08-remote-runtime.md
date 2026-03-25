# 2.3 — RemoteRuntime

**Goal:** Implement `RemoteRuntime` — Worker-safe HTTP forwarder. Routes requests to a runtime reachable via URL.

**Depends on:** 2.1 (Runtime interface, for type conformance)

## What to do

Create `packages/flamecast/src/flamecast/runtimes/remote.ts`:

```typescript
export class RemoteRuntime implements Runtime {
  private readonly url: string;

  constructor(opts: { url: string }) {
    this.url = opts.url;
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const target = new URL(request.url);
    target.host = new URL(this.url).host;
    target.protocol = new URL(this.url).protocol;
    target.pathname = `/sessions/${sessionId}${target.pathname}`;
    return fetch(target.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  }
}
```

Used by:

- `apps/worker` to reach `LocalRuntime.listen()` sidecar in serverless deployments
- As the base pattern for any remote runtime (Fly, E2B, etc. wrap `RemoteRuntime` with lifecycle management)

## Files

- **New:** `packages/flamecast/src/flamecast/runtimes/remote.ts`

## Test Coverage

Integration tests (use a real mock HTTP server, not fetch stubs):

- **HTTP forwarding:** Start a mock HTTP server. `RemoteRuntime({ url })`. `fetchSession(id, request)` arrives at mock with correct path rewriting (`/sessions/:id/start`). Verify method, headers, and body are forwarded.
- **Error propagation:** Mock returns 500. Verify `RemoteRuntime` passes the error response through unchanged (status code + body).
- **Session not found:** `fetchSession` for unknown session hitting `/health`. Verify 404 passes through from the upstream server.

## Acceptance criteria

- `RemoteRuntime({ url: "http://localhost:9000" })` forwards requests correctly
- URL rewriting works: `http://session-host/start` → `http://localhost:9000/sessions/:id/start`
- Worker-safe: no Node.js APIs, no `child_process`
