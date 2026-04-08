# Rust Conductor Integration

## Overview

Replace Flamecast's Go SessionHost with the `durable-acp-rs` Rust
conductor binary. The conductor handles ACP, durable state persistence,
MCP peering, and queue management. Flamecast's React UI subscribes to
the conductor's state stream for reactive updates.

## Architecture

```
BEFORE:
  Flamecast → SessionHost (Go binary) → Agent (stdio)
                 ↕ HTTP callbacks
              EventBus (in-memory ring buffer)
                 ↓
              WS /ws → React UI

AFTER:
  Flamecast → durable-acp-rs (Rust binary) → Agent (stdio)
                 ↕ durable state stream (SSE)
              @durable-acp/client (StreamDB collections)
                 ↓
              React UI (useLiveQuery)
```

## The Rust Binary

```bash
# Usage
durable-acp-rs --port 4437 --name agent-1 npx claude-agent-acp

# Starts:
#   Durable Streams server on :4437
#   REST API + /acp WebSocket on :4438
#   Spawns agent subprocess
```

**Binary location:** `~/gurdasnijor/durable-acp-rs/target/release/durable-acp-rs` (20MB)

**What it provides:**
- Durable state stream at `http://host:4437/durable-acp-state` (SSE)
- ACP client endpoint at `ws://host:4438/acp`
- Queue management at `http://host:4438/api/v1/connections/{id}/queue/*`
- Filesystem access at `http://host:4438/api/v1/connections/{id}/files`
- MCP peering (`list_agents` + `prompt_agent` tools injected into every session)

**Schema compatibility:** 100% verified with `@durable-acp/state` TypeScript schema.
See `~/gurdasnijor/durable-acp-rs/docs/schema-compatibility.md`.

## Seam Lines

### Seam 1: State observation (SSE)
```typescript
import { createDurableACPDB } from "@durable-acp/state";

const db = createDurableACPDB({
  stateStreamUrl: "http://host:4437/durable-acp-state",
});
await db.preload();

// Reactive collections — auto-synced via SSE
db.collections.connections    // ConnectionRow[]
db.collections.promptTurns    // PromptTurnRow[]
db.collections.chunks         // ChunkRow[]
db.collections.permissions    // PermissionRow[]
```

### Seam 2: Prompt submission (ACP over WebSocket)
```typescript
// ACP client connects to conductor's /acp WS endpoint
const ws = new WebSocket("ws://host:4438/acp");
// Full ACP protocol: initialize → newSession → prompt → cancel
```

### Seam 3: Queue management (REST proxy)
```
POST :4438/api/v1/connections/{id}/queue/pause
POST :4438/api/v1/connections/{id}/queue/resume
DELETE :4438/api/v1/connections/{id}/queue/{queueId}
PUT :4438/api/v1/connections/{id}/queue  (reorder)
```

### Seam 4: Filesystem (REST proxy)
```
GET :4438/api/v1/connections/{id}/files?path=/src
GET :4438/api/v1/connections/{id}/fs/tree
```

## Phase 1: Add DurableACPRuntime (~1 day)

Add a new runtime provider that spawns the Rust conductor instead of
the Go SessionHost. Existing runtimes continue working.

### New file: `packages/flamecast/src/runtime/durable-acp.ts`

```typescript
import { spawn } from "node:child_process";
import { Runtime } from "@flamecast/protocol/runtime";

export class DurableACPRuntime implements Runtime<{ binaryPath?: string }> {
  readonly onlyOne = false;

  private processes = new Map<string, {
    proc: ChildProcess;
    dsPort: number;
    apiPort: number;
  }>();

  constructor(private config: {
    binaryPath?: string;  // defaults to PATH lookup
  } = {}) {}

  async start(instanceName: string): Promise<void> {
    const dsPort = await findFreePort();
    const apiPort = dsPort + 1;
    const binaryPath = this.config.binaryPath ?? "durable-acp-rs";

    // The agent command comes from the template at session creation
    // For now, start the conductor without an agent — agent starts on session create
    // Actually: the conductor needs an agent command at startup
    // This means: one conductor per agent, not one conductor per instance
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const entry = this.processes.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);

    // Proxy request to conductor's REST API
    const url = new URL(request.url);
    const conductorUrl = `http://127.0.0.1:${entry.apiPort}${url.pathname}${url.search}`;
    return fetch(conductorUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  }

  getWebsocketUrl(sessionId: string): string | undefined {
    const entry = this.processes.get(sessionId);
    return entry ? `ws://127.0.0.1:${entry.apiPort}/acp` : undefined;
  }

  getStateStreamUrl(sessionId: string): string | undefined {
    const entry = this.processes.get(sessionId);
    return entry ? `http://127.0.0.1:${entry.dsPort}/durable-acp-state` : undefined;
  }
}
```

### Key difference from Go SessionHost

The Go SessionHost is a **generic session manager** — it spawns any
agent and proxies HTTP. The Rust conductor is an **ACP conductor** —
it interprets ACP messages, persists state, and manages queue/permissions.

This means the Rust conductor doesn't use Flamecast's `handleSessionEvent`
callback pattern. State changes appear on the durable stream instead.
Flamecast subscribes, not polls.

### Registration in `apps/server/src/index.ts`

```typescript
import { DurableACPRuntime } from "@flamecast/sdk";

const flamecast = new Flamecast({
  runtimes: {
    local: new NodeRuntime(),       // existing Go SessionHost
    "durable-acp": new DurableACPRuntime({
      binaryPath: "/path/to/durable-acp-rs",
    }),
    docker: new DockerRuntime(),    // existing
  },
});
```

### Agent template example

```json
{
  "name": "Claude with durable state",
  "spawn": { "command": "npx", "args": ["claude-agent-acp"] },
  "runtime": { "provider": "durable-acp" }
}
```

## Phase 2: React UI state subscription (~2 days)

### New dependency: `@durable-acp/client`

Published from `~/gurdasnijor/distributed-acp/packages/durable-acp-client/`.
Provides `DurableACPClient` which:
- Subscribes to state stream via SSE
- Materializes collections (connections, chunks, turns, permissions)
- Provides `prompt()`, `cancel()`, `resolvePermission()` via REST/WS

### New hook: `useDurableACPSession(connectionId, stateStreamUrl)`

```typescript
function useDurableACPSession(connectionId: string, stateStreamUrl: string) {
  const client = useMemo(() => new DurableACPClient({
    connectionId,
    stateStreamUrl,
    onChunk: (chunk) => setChunks(prev => [...prev, chunk]),
    onTurnComplete: (turn) => setTurns(prev => updateTurn(prev, turn)),
    onPermission: (perm) => setPermissions(prev => [...prev, perm]),
  }), [connectionId, stateStreamUrl]);

  useEffect(() => {
    client.connect();
    return () => client.dispose();
  }, [client]);

  return { chunks, turns, permissions, prompt, cancel, respondToPermission };
}
```

### Conditional hook selection

```typescript
// In useFlamecastSession or useSessionState:
if (session.runtime?.provider === "durable-acp") {
  // Use DurableACPClient + state stream
  return useDurableACPSession(session.id, session.stateStreamUrl);
} else {
  // Use existing EventBus + WebSocket
  return useFlamecastSession(session.id);
}
```

## Phase 3: Storage simplification (~1 day)

Once all sessions use the `durable-acp` runtime:
- Session metadata lives in the state stream (not PostgreSQL)
- `FlamecastStorage` reduces to template management only
- `@flamecast/psql` can be simplified or replaced with flat file

## Phase 4: Cleanup (~0.5 day)

- Remove `@flamecast/session-host-go` package
- Remove EventBus + WS channel protocol
- Remove `handleSessionEvent` callback pattern
- Simplify Hono API to thin proxy → conductor REST

## What This Gains Over Current Smithery

| Capability | Current | After Integration |
|---|---|---|
| Session durability | In-memory (lost on restart) | Durable stream (survives restart) |
| Agent-to-agent messaging | Not available | MCP peering automatic |
| ACP compliance | Custom REST API | Standard ACP over /acp WS |
| State observation | EventBus → WS (proprietary) | SSE stream (HTTP standard) |
| Multi-agent | 1 session per agent | Multiple conductors, shared state |
| Stateless integrations | Requires persistent WS | SSE + webhook (serverless OK) |
| Session replay | Not possible | Replay from any stream offset |

## Prerequisites

- Rust binary built and accessible (PATH or explicit path)
- `@durable-acp/client` + `@durable-acp/state` published to npm or
  workspace-linked
- Schema compatibility verified (already done — see Rust docs)
