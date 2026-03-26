# `@flamecast/agent-js`

This example runs a Flamecast-compatible JS agent as a Cloudflare Worker.

It keeps the runtime surface small:

- Flamecast SessionHost routes at `/sessions/:sessionId`
- one Cloudflare `Agent` instance per session
- one native tool exposed to the model: `executeJS`
- shared REPL-like JS scope across turns
- transcript compaction
- Dynamic Workers for `executeJS`

## How It Works

Flamecast talks to this worker through the normal SessionHost contract. There is no Flamecast-specific runtime bridge inside this package.

The flow is:

1. Flamecast points `NodeRuntime` at the worker base URL.
2. Flamecast starts a session with `POST /sessions/:sessionId/start`.
3. The worker resolves that `sessionId` to a named Cloudflare `Agent` instance with `getAgentByName(...)`.
4. That `Agent` instance owns the session transcript, compaction summary, and JSON-serializable globals in Durable Object SQLite.
5. Prompts stream over `WS /sessions/:sessionId` as normal SessionHost events.
6. When the model chooses `executeJS`, the worker runs the code in a Dynamic Worker and writes the updated scope back to the session state.

So the important boundary is:

- Flamecast sees a normal remote SessionHost
- the Cloudflare Worker owns the agent loop
- `executeJS` is the only model-visible capability

## Execution Model

The model contract is:

- respond directly when no tool is needed
- otherwise use `executeJS`, as many times as needed, until it is ready to answer
- `executeJS` runs in a shared session scope with REPL-like semantics
- a final expression is returned automatically, and explicit `return` still works
- `executeJS` can use `fetch(...)` for outbound HTTP(S) requests
- `executeJS` can use `await import("node:fs")` for the Worker virtual filesystem
- persisted globals should stay JSON-serializable

Example:

```js
counter = typeof counter === "number" ? counter : 0;
counter += 1;
counter
```

The session mental model is “real globals across turns.” Internally, the harness checkpoints serializable state between executions so that behavior survives Dynamic Worker hops and cold starts.

## Context Management

The only built-in context primitive is compaction:

- when serialized transcript size crosses `COMPACT_AT_CHARS`, older turns are summarized
- the most recent turns are kept verbatim according to `KEEP_RECENT_TURNS`
- recent `[User]`, `[Assistant]`, and `[Tool result]` blocks stay in context after compaction

## SessionHost Surface

The worker exposes:

- `GET /health`
- `POST /sessions/:sessionId/start`
- `POST /sessions/:sessionId/prompt`
- `POST /sessions/:sessionId/terminate`
- `GET /sessions/:sessionId/queue`
- `GET /sessions/:sessionId/fs/snapshot`
- `WS /sessions/:sessionId`

`/start` returns `hostUrl`, `websocketUrl`, and `acpSessionId` because that is part of Flamecast’s existing SessionHost start response shape. Here `acpSessionId` is just the session ID.

## What Runs Where

Each Flamecast session maps to a named Cloudflare `Agent` instance. That `Agent` stores:

- transcript
- compaction summary
- current working directory
- shared JS globals

Each `executeJS` step runs in a generated Dynamic Worker. The parent worker stays responsible for:

- prompt orchestration
- tool-call streaming
- compaction
- persistence

`node:fs` support comes from the Cloudflare Worker runtime:

- `/tmp` is writable scratch space for a single request
- `/bundle` is read-only bundled content
- cross-turn state should live in session globals, not the filesystem

## Install

From the repo root:

```bash
pnpm install
```

## Run Locally

Start the worker with Wrangler:

```bash
pnpm --filter @flamecast/agent-js dev
```

This runs the worker locally at `http://127.0.0.1:8787`.

Useful endpoints:

- `GET /health`
- `POST /sessions/:sessionId/start`
- `WS /sessions/:sessionId`

The checked-in Wrangler config already includes the non-secret gateway vars:

- `AGENT_MODE=gateway`
- `CF_ACCOUNT_ID=c4cf21d8a5e8878bc3c92708b1f80193`
- `CF_AI_GATEWAY=smithery-agent`
- `CF_AI_MODEL=openai/gpt-5.4`

For local gateway mode, provide `CF_AI_GATEWAY_TOKEN` in your shell before starting Wrangler:

```bash
export CF_AI_GATEWAY_TOKEN=...
pnpm --filter @flamecast/agent-js dev
```

For deterministic smoke tests, override the mode:

```bash
AGENT_MODE=scripted pnpm --filter @flamecast/agent-js dev
```

## Run It Through Flamecast Locally

Start the worker:

```bash
pnpm --filter @flamecast/agent-js dev
```

Then start Flamecast with the worker URL registered:

```bash
FLAMECAST_AGENT_JS_BASE_URL=http://127.0.0.1:8787 pnpm dev
```

`agentjs` is only registered when `FLAMECAST_AGENT_JS_BASE_URL` is set. That keeps the default Flamecast runtime list generic.

If you want to register a template through the API:

```bash
curl -X POST http://127.0.0.1:3001/api/agent-templates \
  -H 'content-type: application/json' \
  -d '{
    "name": "Agent.js local",
    "spawn": { "command": "remote-sessionhost", "args": ["agentjs"] },
    "runtime": { "provider": "agentjs" }
  }'
```

## Test

```bash
pnpm --filter @flamecast/agent-js test
```

The integration tests start the worker with local Wrangler, then verify:

- SessionHost prompts work end to end
- `executeJS` preserves shared scope across turns
- `node:fs` works against the Worker virtual filesystem
- reconnecting the same session preserves state
- Flamecast can talk to the worker through `NodeRuntime`

## Use AI Gateway

Set these environment variables before starting the worker if you want to override the checked-in defaults:

```bash
export AGENT_MODE=gateway
export CF_ACCOUNT_ID=...
export CF_AI_GATEWAY=...
export CF_AI_GATEWAY_TOKEN=...
export CF_AI_MODEL=openai/gpt-5.4
```

The worker uses [`ai`](https://www.npmjs.com/package/ai) and [`ai-gateway-provider`](https://www.npmjs.com/package/ai-gateway-provider) only in gateway mode.

## Deploy

```bash
pnpm --filter @flamecast/agent-js deploy
```

The worker name is `flamecast-agent-js`. The Wrangler config enables both the Agent Durable Object and the Dynamic Worker loader:

```json
{
  "durable_objects": {
    "bindings": [{ "name": "AcpSessionAgent", "class_name": "AcpSessionAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["AcpSessionAgent"] }],
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

`CF_AI_GATEWAY_TOKEN` should be configured as a Worker secret before deploy:

```bash
printf %s "$CF_AI_GATEWAY_TOKEN" | pnpm wrangler secret put CF_AI_GATEWAY_TOKEN
```

If your gateway does not already have a stored OpenAI key configured, also set `OPENAI_API_KEY`:

```bash
printf %s "$OPENAI_API_KEY" | pnpm wrangler secret put OPENAI_API_KEY
```

## Flamecast Integration

Because the worker already exposes the SessionHost contract, Flamecast can use a normal [`NodeRuntime`](/Users/henry/.codex/worktrees/6f43/flamecast-v2/packages/flamecast/src/flamecast/runtime-node.ts):

```ts
import { Flamecast, NodeRuntime } from "@flamecast/sdk";

const flamecast = new Flamecast({
  runtimes: {
    default: new NodeRuntime(),
    ...(process.env.FLAMECAST_AGENT_JS_BASE_URL
      ? { agentjs: new NodeRuntime(process.env.FLAMECAST_AGENT_JS_BASE_URL) }
      : {}),
  },
});
```
