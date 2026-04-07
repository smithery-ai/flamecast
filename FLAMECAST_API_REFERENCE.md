# Flamecast API Reference

> Complete reference for all REST APIs, WebSocket events, and React hooks.
> Built from implementation source code in `packages/flamecast`, `packages/protocol`, and `packages/ui`.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Getting Started](#getting-started)
3. [REST API](#rest-api)
4. [WebSocket Protocol](#websocket-protocol)
5. [React Hooks](#react-hooks)
6. [Core Types](#core-types)
7. [Webhook System](#webhook-system)

---

## Architecture Overview

Flamecast is an open-source control plane for AI agent sessions, built on the Agent Client Protocol (ACP). The architecture has three layers:

```
React Client  <--REST/WS-->  Flamecast Server (Hono)  <--ACP-->  Runtime Hosts (Go sidecar)
  (packages/ui)                (packages/flamecast)                (packages/session-host-go)
```

**Key packages:**

| Package | npm name | Purpose |
|---------|----------|---------|
| `packages/flamecast` | `@flamecast/sdk` | Core SDK: Hono API server, client SDK, CLI |
| `packages/protocol` | `@flamecast/protocol` | All TypeScript types/interfaces (no runtime code) |
| `packages/ui` | `@flamecast/ui` | React hooks & components for building UIs |
| `packages/flamecast-psql` | `@flamecast/storage-psql` | PostgreSQL / PGLite storage backend |
| `packages/runtime-docker` | `@flamecast/runtime-docker` | Docker runtime provider |
| `packages/runtime-e2b` | `@flamecast/runtime-e2b` | E2B sandbox runtime provider |

---

## Getting Started

### Install the SDK

```bash
npm install @flamecast/sdk
```

### Create a client

```ts
import { createFlamecastClient } from "@flamecast/sdk/client";

const client = createFlamecastClient({
  baseUrl: "http://localhost:3001/api",
});
```

### Use in React

```tsx
import { FlamecastProvider } from "@flamecast/ui";
import { createFlamecastClient } from "@flamecast/sdk/client";

const client = createFlamecastClient({ baseUrl: "/api" });

function App() {
  return (
    <FlamecastProvider client={client}>
      <YourApp />
    </FlamecastProvider>
  );
}
```

---

## REST API

All routes are prefixed with `/api`. The server uses [Hono](https://hono.dev/) with Zod validation.

### Health

#### `GET /api/health`

Check server health.

**Response:**

```ts
// 200
{ status: "ok", sessions: number }

// 503
{ status: "degraded", error: string }
```

---

### Agent Templates

Agent templates define reusable configurations for spawning agents.

#### `GET /api/agent-templates`

List all registered agent templates.

**Response:** `AgentTemplate[]`

---

#### `POST /api/agent-templates`

Register a new agent template.

**Request body:**

```ts
{
  name: string;                      // required, min 1 char
  spawn: {
    command: string;
    args?: string[];
  };
  runtime?: {
    provider: string;                // must match a registered runtime
    setup?: string;
    env?: Record<string, string>;
  };
  env?: Record<string, string>;
}
```

**Response:** `AgentTemplate` (201 Created)

---

#### `PUT /api/agent-templates/:id`

Update an existing agent template.

**Request body:** Same fields as POST, all optional.

**Response:** `AgentTemplate` (200) or 404

---

### Sessions (Agents)

Sessions represent running agent instances.

#### `GET /api/agents`

List all active sessions.

**Response:** `Session[]`

---

#### `POST /api/agents`

Create and start a new agent session.

**Request body:**

```ts
{
  agentTemplateId?: string;           // use a template (mutually exclusive with spawn)
  spawn?: { command: string; args?: string[] };  // inline spawn (mutually exclusive with agentTemplateId)
  cwd?: string;                       // working directory
  name?: string;                      // display name
  runtimeInstance?: string;           // target runtime instance
  webhooks?: Array<{
    url: string;
    secret: string;
    events?: WebhookEventType[];      // filter which events to deliver
  }>;
}
```

> You must provide exactly one of `agentTemplateId` or `spawn`.

**Response:** `Session` (201 Created)

---

#### `GET /api/agents/:agentId`

Get current state of a session.

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `includeFileSystem` | `"true"` | Include filesystem snapshot |
| `showAllFiles` | `"true"` | Show hidden/dot files |

**Response:** `Session` (200) or 404

---

#### `DELETE /api/agents/:agentId`

Terminate a session.

**Response:** `{ ok: true }` (200), 404, or 409 (already killed)

---

#### `POST /api/agents/:agentId/prompts`

Send a prompt to the agent.

**Request body:**

```ts
{ text: string }
```

**Response:** execution result (200) or `QueuedPromptResponse` if agent is busy:

```ts
{ queued: true, queueId: string, position: number }
```

---

#### `POST /api/agents/:agentId/permissions/:requestId`

Resolve a pending permission request.

**Request body:**

```ts
{ optionId: string }          // approve with specific option
// OR
{ outcome: "cancelled" }      // deny/cancel
```

**Response:** JSON (200), 404, or 500

---

#### `POST /api/agents/:agentId/events`

Handle session-host callback events.

**Request body:**

```ts
{ type: string; data: Record<string, unknown> }
```

---

### Prompt Queue Management

Each session has a prompt queue that buffers prompts when the agent is busy.

#### `GET /api/agents/:agentId/queue`

Get queue state.

**Response:** `PromptQueueState`

---

#### `DELETE /api/agents/:agentId/queue/:queueId`

Cancel a specific queued prompt.

---

#### `DELETE /api/agents/:agentId/queue`

Clear the entire queue.

---

#### `PUT /api/agents/:agentId/queue`

Reorder queue items.

**Request body:**

```ts
{ order: string[] }   // array of queueIds in desired order
```

---

#### `POST /api/agents/:agentId/queue/pause`

Pause queue processing. Queued prompts won't execute until resumed.

---

#### `POST /api/agents/:agentId/queue/resume`

Resume queue processing.

---

### Files

#### `GET /api/agents/:agentId/files?path=<path>`

Preview a file inside the agent's runtime.

**Response:** `FilePreview`

```ts
{ path: string; content: string; truncated: boolean; maxChars: number }
```

---

#### `GET /api/agents/:agentId/fs/snapshot`

Get a filesystem tree snapshot.

**Query params:** `showAllFiles` (`"true"` to include hidden files)

**Response:** `FileSystemSnapshot`

```ts
{
  root: string;
  entries: Array<{ path: string; type: "file" | "directory" | "symlink" | "other" }>;
  truncated: boolean;
  maxEntries: number;
}
```

---

### Runtimes

Runtimes are sandboxed environments where agents execute (Docker, E2B, or local).

#### `GET /api/runtimes`

List all registered runtime types and their instances.

**Response:** `RuntimeInfo[]`

```ts
{
  typeName: string;
  instances: RuntimeInstance[];
}
```

---

#### `POST /api/runtimes/:typeName/start`

Start a new runtime instance.

**Request body:**

```ts
{ name?: string }    // optional custom instance name
```

**Response:** `RuntimeInstance` (201 Created)

---

#### `POST /api/runtimes/:instanceName/stop`

Stop a runtime instance.

---

#### `DELETE /api/runtimes/:instanceName`

Delete a runtime instance.

---

#### `POST /api/runtimes/:instanceName/pause`

Pause a runtime instance.

---

#### `GET /api/runtimes/:instanceName/files?path=<path>`

Preview a file in the runtime.

**Response:** `FilePreview`

---

#### `GET /api/runtimes/:instanceName/fs/snapshot`

Get filesystem snapshot from a runtime.

**Query params:** `showAllFiles` (`"true"`)

**Response:** `FileSystemSnapshot`

---

### Server-Sent Events (SSE)

#### `GET /api/agents/:agentId/stream`

Stream real-time events for a session via SSE.

**Headers:**

| Header | Description |
|--------|-------------|
| `Last-Event-ID` | Resume from a specific event (replays missed events) |

**Events emitted:**

- Historical events (replayed from `Last-Event-ID` onward)
- `session.created` — new session started
- `session.terminated` — session ended
- All session events in real time

---

## WebSocket Protocol

Flamecast uses a channel-based WebSocket protocol for real-time bidirectional communication. This is the primary way to interact with sessions in real time.

### Connecting

Open a WebSocket to the session's `websocketUrl` (returned in the `Session` object from REST).

### Connection Flow

```
1. Client opens WebSocket connection
2. Server sends: { type: "connected", connectionId: "..." }
3. Client sends: { action: "subscribe", channel: "session:<id>" }
4. Server sends: { type: "subscribed", channel: "session:<id>" }
5. Server replays historical events (if `since` was provided)
6. Server streams live events as they occur
```

---

### Channels

Events are organized into hierarchical channels. Subscribing to a parent channel receives events from all child channels.

```
agents                                    ← all agent events
agent:<agentId>                           ← events for one agent
session:<sessionId>                       ← events for one session
session:<sessionId>:queue                 ← queue events
session:<sessionId>:fs                    ← filesystem events
session:<sessionId>:terminal              ← all terminal events
session:<sessionId>:terminal:<terminalId> ← one terminal's events
```

A subscription to `session:abc` matches `session:abc`, `session:abc:queue`, `session:abc:terminal`, etc.

---

### Server to Client Messages

#### `connected`

Sent immediately on connection.

```ts
{ type: "connected", connectionId: string }
```

#### `subscribed`

Confirms channel subscription.

```ts
{ type: "subscribed", channel: string }
```

#### `unsubscribed`

Confirms channel unsubscription.

```ts
{ type: "unsubscribed", channel: string }
```

#### `event`

Real-time event delivery.

```ts
{
  type: "event",
  channel: string,
  sessionId: string,
  agentId: string,
  seq: number,               // monotonic sequence number
  event: {
    type: string,            // e.g. "rpc", "permission_request", "terminal.data"
    data: Record<string, unknown>,
    timestamp: string
  }
}
```

#### `session.created`

Broadcast when a new session starts.

```ts
{ type: "session.created", sessionId: string, agentId: string }
```

#### `session.terminated`

Broadcast when a session ends.

```ts
{ type: "session.terminated", sessionId: string, agentId: string }
```

#### `error`

Error notification.

```ts
{ type: "error", message: string, channel?: string }
```

#### `pong`

Response to a ping heartbeat.

```ts
{ type: "pong" }
```

---

### Client to Server Messages

#### `subscribe`

Subscribe to a channel. Use `since` to replay events after a sequence number (for reconnection).

```ts
{ action: "subscribe", channel: string, since?: number }
```

#### `unsubscribe`

```ts
{ action: "unsubscribe", channel: string }
```

#### `prompt`

Send a prompt to an agent.

```ts
{ action: "prompt", sessionId: string, text: string }
```

#### `permission.respond`

Respond to a permission request.

```ts
{
  action: "permission.respond",
  sessionId: string,
  requestId: string,
  body: { optionId: string } | { outcome: "cancelled" }
}
```

#### `cancel`

Cancel the current operation or a specific queued item.

```ts
{ action: "cancel", sessionId: string, queueId?: string }
```

#### `terminate`

Terminate a session.

```ts
{ action: "terminate", sessionId: string }
```

#### `queue.reorder`

Reorder the prompt queue.

```ts
{ action: "queue.reorder", sessionId: string, order: string[] }
```

#### `queue.clear`

Clear all queued prompts.

```ts
{ action: "queue.clear", sessionId: string }
```

#### `queue.pause`

Pause queue processing.

```ts
{ action: "queue.pause", sessionId: string }
```

#### `queue.resume`

Resume queue processing.

```ts
{ action: "queue.resume", sessionId: string }
```

#### `ping`

Heartbeat.

```ts
{ action: "ping" }
```

#### `terminal.create`

Create a new terminal in the runtime (independent of agent sessions).

```ts
{ action: "terminal.create", sessionId?: string, data?: string, cols?: number, rows?: number }
```

#### `terminal.input`

Send input to a terminal.

```ts
{ action: "terminal.input", terminalId: string, data: string }
```

#### `terminal.resize`

Resize a terminal.

```ts
{ action: "terminal.resize", terminalId: string, cols: number, rows: number }
```

#### `terminal.kill`

Kill a terminal.

```ts
{ action: "terminal.kill", terminalId: string }
```

---

### Event Types by Channel

| Category | Event Types | Channel |
|----------|-------------|---------|
| Terminal | `terminal.create`, `terminal.data`, `terminal.output`, `terminal.exit` | `session:X:terminal:terminalId` |
| Queue | `queue.updated`, `queue.paused`, `queue.resumed` | `session:X:queue` |
| Filesystem | `filesystem.changed`, `filesystem.snapshot`, `file.preview`, `fs.*` | `session:X:fs` |
| Session | `rpc`, `session_update`, `permission_request`, custom events | `session:X` |

### Event History

The server maintains ring buffers per session for replay on reconnect:

| Category | Buffer size |
|----------|-------------|
| Terminal events | 5,000 |
| RPC events | 2,000 |
| Snapshots (queue/fs) | 100 |
| Default | 1,000 |

---

## React Hooks

All hooks are exported from `@flamecast/ui`. They require a `<FlamecastProvider>` ancestor.

### Provider Setup

```tsx
import { FlamecastProvider, useFlamecastClient } from "@flamecast/ui";

<FlamecastProvider client={flamecastClient}>
  {children}
</FlamecastProvider>
```

---

### Data Fetching Hooks

These use TanStack React Query under the hood. They return standard `useQuery` results (`data`, `isLoading`, `error`, `refetch`, etc.).

#### `useAgentTemplates()`

Fetch all agent templates.

```ts
const { data: templates, isLoading } = useAgentTemplates();
// data: AgentTemplate[]
```

---

#### `useSessions()`

Fetch all sessions. Auto-refetches every 30 seconds.

```ts
const { data: sessions, isLoading } = useSessions();
// data: Session[]
```

---

#### `useSession(id, opts?)`

Fetch a single session with filesystem.

```ts
const { data: session } = useSession("session-123", {
  showAllFiles: true,   // include hidden files
});
// data: Session (with fileSystem populated)
```

> Uses infinite stale time -- data never auto-refetches.

---

#### `useRuntimes()`

Fetch all runtime types and instances. Auto-refetches every 30 seconds.

```ts
const { data: runtimes } = useRuntimes();
// data: RuntimeInfo[]
```

---

#### `useRuntimeFileSystem(instanceName, opts?)`

Fetch filesystem for a runtime instance. Auto-refetches every 30 seconds.

```ts
const { data: fs } = useRuntimeFileSystem("my-docker-1", {
  enabled: true,          // conditionally enable
  showAllFiles: false,
});
// data: FileSystemSnapshot
```

---

### Mutation Hooks

These use TanStack React Query's `useMutation`. They return `{ mutate, mutateAsync, isPending, isError, ... }`.

#### `useCreateSession(opts?)`

Create a new agent session.

```ts
const createSession = useCreateSession({
  onSuccess: (session) => navigate(`/sessions/${session.id}`),
  onError: (err) => toast.error(err.message),
});

createSession.mutate({
  agentTemplateId: "template-123",
  runtimeInstance: "docker-1",
});
```

---

#### `useTerminateSession(opts?)`

Terminate a session by ID.

```ts
const terminate = useTerminateSession({
  onSuccess: (id) => console.log(`Terminated ${id}`),
});

terminate.mutate("session-123");
```

---

#### `useRegisterAgentTemplate(opts?)`

Register a new agent template.

```ts
const register = useRegisterAgentTemplate({
  onSuccess: (template) => console.log(`Created ${template.id}`),
});

register.mutate({
  name: "My Agent",
  command: "node",
  args: ["agent.js"],
  provider: "docker",
  setup: "npm install",
  env: { NODE_ENV: "production" },
});
```

---

#### `useUpdateAgentTemplate(templateId, opts?)`

Update an existing agent template.

```ts
const update = useUpdateAgentTemplate("template-123", {
  onSuccess: (template) => toast.success("Updated!"),
});

update.mutate({
  name: "Renamed Agent",
  command: "node",
  args: ["agent.js"],
  provider: "e2b",
});
```

---

#### `useStartRuntime(opts?)`

Start a runtime instance.

```ts
const start = useStartRuntime({
  onSuccess: (instance) => console.log(`Started ${instance.name}`),
});

start.mutate({ typeName: "docker", name: "my-instance" });
```

---

#### `useStartRuntimeWithOptimisticUpdate(runtimeInfo, opts?)`

Start a runtime with immediate optimistic UI updates.

```ts
const start = useStartRuntimeWithOptimisticUpdate(dockerRuntime, {
  instanceName: "new-docker-1",
  onSuccess: (instance) => navigate(`/runtimes/${instance.name}`),
});

start.mutate();  // no args needed -- config comes from hook params
```

---

#### `useStopRuntime(opts?)`

Stop a runtime instance by name. Invalidates both `runtimes` and `sessions` queries.

```ts
const stop = useStopRuntime();
stop.mutate("my-instance");
```

---

#### `usePauseRuntime(opts?)`

Pause a runtime instance.

```ts
const pause = usePauseRuntime();
pause.mutate("my-instance");
```

---

#### `useDeleteRuntime(opts?)`

Delete a runtime instance. Uses optimistic cache updates.

```ts
const del = useDeleteRuntime();
del.mutate("my-instance");
```

---

### WebSocket Hooks

#### `useFlamecastSession(sessionId, websocketUrl?)`

The primary hook for real-time session interaction. Manages the WebSocket lifecycle including auto-reconnect with exponential backoff.

```ts
const {
  events,              // SessionLog[] - all events received
  connectionState,     // "disconnected" | "connecting" | "connected" | "reconnecting"
  isConnected,         // boolean shorthand
  prompt,              // (text: string) => void
  respondToPermission, // (requestId: string, body) => void
  cancel,              // (queueId?: string) => void
  terminate,           // () => void
  requestFilePreview,  // (path: string) => Promise<void>
  requestFsSnapshot,   // (opts?) => Promise<void>
  send,                // (message: WsChannelControlMessage) => void
} = useFlamecastSession("session-123", "wss://host/ws");
```

**Features:**
- Auto-subscribes to `session:<sessionId>` on connect
- Exponential backoff reconnection (max 5 attempts, up to 16s delay)
- Message deduplication across reconnects
- Sequence tracking for replay (`since` parameter)

---

#### `useTerminal(websocketUrl?)`

Manage runtime-level terminals (independent of agent sessions).

```ts
const {
  terminals,           // TerminalSession[] - active terminals
  activeTerminal,      // TerminalSession | null
  createTerminal,      // (command?: string) => void
  sendInput,           // (terminalId: string, data: string) => void
  resize,              // (terminalId: string, cols: number, rows: number) => void
  killTerminal,        // (terminalId: string) => void
  onData,              // (terminalId: string, listener: (data: string) => void) => unsubscribe
} = useTerminal("wss://host/ws");
```

**`TerminalSession` shape:**

```ts
{
  terminalId: string;
  command?: string;
  output: string;
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
}
```

---

### Composite Hooks

#### `useSessionState(sessionId, opts?)`

All-in-one session state hook combining REST data and WebSocket events.

```ts
const {
  session,               // Session | undefined
  isLoading,             // boolean
  connectionState,       // ConnectionState
  isConnected,           // boolean
  logs,                  // SessionLog[] - merged REST + WS logs
  markdownSegments,      // parsed markdown segments from logs
  isProcessing,          // boolean - agent is currently working
  pendingPermissions,    // PermissionRequestEvent[]
  respondToPermission,   // (requestId, body) => void
  fileEntries,           // FileSystemEntry[]
  workspaceRoot,         // string | null
  showAllFiles,          // boolean
  setShowAllFiles,       // (value: boolean) => void
  prompt,                // (text: string) => void
  cancel,                // (queueId?: string) => void
  terminate,             // () => void
  requestFilePreview,    // (path: string) => Promise<void>
} = useSessionState("session-123", { showAllFiles: false });
```

This is the recommended hook for building session UIs -- it handles merging REST snapshots with WebSocket events, tracking permissions, filesystem state, and processing status.

---

### Utility Hooks

#### `useFlamecastClient()`

Access the `FlamecastClient` instance from context.

```ts
const client = useFlamecastClient();
const sessions = await client.fetchSessions();
```

---

#### `useIsMobile()`

Detect mobile viewport (< 768px).

```ts
const isMobile = useIsMobile();
```

---

## Core Types

All types are defined in `@flamecast/protocol` and re-exported from `@flamecast/sdk`.

### Session

```ts
interface Session {
  id: string;
  agentName: string;
  spawn: AgentSpawn;
  startedAt: string;                          // ISO timestamp
  lastUpdatedAt: string;                      // ISO timestamp
  status: "active" | "killed";
  logs: SessionLog[];
  pendingPermission: PendingPermission | null;
  fileSystem: FileSystemSnapshot | null;
  promptQueue: PromptQueueState | null;
  websocketUrl?: string;                      // WebSocket URL for real-time events
  runtime?: string;                           // runtime instance name
}
```

### AgentTemplate

```ts
interface AgentTemplate {
  id: string;
  name: string;
  spawn: AgentSpawn;
  runtime: AgentTemplateRuntime;
  env?: Record<string, string>;
}

interface AgentSpawn {
  command: string;
  args: string[];
}

interface AgentTemplateRuntime {
  provider: string;
  image?: string;
  dockerfile?: string;
  setup?: string;
  env?: Record<string, string>;
}
```

### SessionLog

```ts
interface SessionLog {
  timestamp: string;
  type: string;                               // e.g. "rpc", "permission_request", "terminal.data"
  data: Record<string, unknown>;
}
```

### PendingPermission

```ts
interface PendingPermission {
  requestId: string;
  toolCallId: string;
  title: string;
  kind?: string;
  options: PendingPermissionOption[];
}

interface PendingPermissionOption {
  optionId: string;
  name: string;
  kind: string;                               // e.g. "allow_once", "reject_once"
}
```

### FileSystemSnapshot

```ts
interface FileSystemSnapshot {
  root: string;
  entries: FileSystemEntry[];
  truncated: boolean;
  maxEntries: number;
}

interface FileSystemEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
}
```

### FilePreview

```ts
interface FilePreview {
  path: string;
  content: string;
  truncated: boolean;
  maxChars: number;
}
```

### PromptQueueState

```ts
interface PromptQueueState {
  processing: boolean;
  paused: boolean;
  items: PromptQueueItem[];
  size: number;
}

interface PromptQueueItem {
  queueId: string;
  text: string;
  enqueuedAt: string;
  position: number;
}
```

### RuntimeInfo & RuntimeInstance

```ts
interface RuntimeInfo {
  typeName: string;
  instances: RuntimeInstance[];
}

interface RuntimeInstance {
  name: string;
  // ... runtime-specific fields
}
```

---

## Webhook System

Flamecast can deliver events to external URLs via webhooks with HMAC signature verification.

### Configuration

Register webhooks when creating a session:

```ts
await client.createSession({
  agentTemplateId: "template-123",
  webhooks: [
    {
      url: "https://example.com/webhook",
      secret: "your-hmac-secret",
      events: ["permission_request", "end_turn"],  // optional filter
    },
  ],
});
```

### Webhook Event Types

| Event | Description |
|-------|-------------|
| `permission_request` | Agent needs permission to perform an action |
| `end_turn` | Agent finished processing a prompt |
| `error` | Agent encountered an error |
| `session_end` | Session terminated |

### Payload Format

```ts
interface WebhookPayload {
  sessionId: string;
  eventId: string;
  timestamp: string;
  event: {
    type: WebhookEventType;
    data: Record<string, unknown>;
  };
}
```

### Verification Headers

| Header | Description |
|--------|-------------|
| `X-Flamecast-Signature` | HMAC signature of the payload |
| `X-Flamecast-Event-Id` | Unique event identifier |
| `X-Flamecast-Session-Id` | Session that generated the event |

### Delivery Guarantees

- Retries with exponential backoff: 0s, 5s, 30s, 120s, 600s
- Per-session per-webhook serial delivery (ordering guaranteed)
- 10 second timeout per attempt

---

## Client SDK Methods Reference

The `FlamecastClient` object (from `createFlamecastClient`) provides these methods:

### Agent Templates

| Method | Signature | Description |
|--------|-----------|-------------|
| `fetchAgentTemplates` | `() => Promise<AgentTemplate[]>` | List all templates |
| `registerAgentTemplate` | `(body) => Promise<AgentTemplate>` | Create a template |
| `updateAgentTemplate` | `(id, body) => Promise<AgentTemplate>` | Update a template |

### Sessions

| Method | Signature | Description |
|--------|-----------|-------------|
| `fetchSessions` | `() => Promise<Session[]>` | List all sessions |
| `fetchSession` | `(id, opts?) => Promise<Session>` | Get one session |
| `createSession` | `(body) => Promise<Session>` | Create a session |
| `terminateSession` | `(id) => Promise<void>` | Kill a session |
| `promptSession` | `(id, text) => Promise<PromptResult>` | Send a prompt |
| `resolvePermission` | `(sessionId, requestId, body) => Promise<...>` | Answer permission |

### Queue Management

| Method | Signature | Description |
|--------|-----------|-------------|
| `fetchQueue` | `(id) => Promise<PromptQueueState>` | Get queue state |
| `cancelQueueItem` | `(id, queueId) => Promise<void>` | Cancel one item |
| `clearQueue` | `(id) => Promise<void>` | Clear entire queue |
| `reorderQueue` | `(id, order) => Promise<void>` | Reorder items |
| `pauseQueue` | `(id) => Promise<void>` | Pause processing |
| `resumeQueue` | `(id) => Promise<void>` | Resume processing |

### Files

| Method | Signature | Description |
|--------|-----------|-------------|
| `fetchSessionFilePreview` | `(id, path) => Promise<FilePreview>` | Preview agent file |
| `fetchSessionFileSystem` | `(id, opts?) => Promise<FileSystemSnapshot>` | Agent filesystem |
| `fetchRuntimeFilePreview` | `(instance, path) => Promise<FilePreview>` | Preview runtime file |
| `fetchRuntimeFileSystem` | `(instance, opts?) => Promise<FileSystemSnapshot>` | Runtime filesystem |

### Runtimes

| Method | Signature | Description |
|--------|-----------|-------------|
| `fetchRuntimes` | `() => Promise<RuntimeInfo[]>` | List runtimes |
| `startRuntime` | `(typeName, name?) => Promise<RuntimeInstance>` | Start instance |
| `stopRuntime` | `(instanceName) => Promise<void>` | Stop instance |
| `pauseRuntime` | `(instanceName) => Promise<void>` | Pause instance |
| `deleteRuntime` | `(instanceName) => Promise<void>` | Delete instance |
