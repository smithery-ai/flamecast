# `@flamecast/agent-js`

This example runs a Flamecast-compatible ACP agent as a Cloudflare Worker.

It keeps the harness minimal:

- ACP over WebSocket at `/acp/:sessionId`
- one Cloudflare `Agent` instance per Flamecast session
- one native tool exposed to the model: `executeJS`
- shared session scope across turns
- built-in transcript compaction
- local Miniflare mode for development
- Dynamic Workers in production when the `LOADER` binding is available

## Design

This example intentionally does not expose shell, filesystem, or a typed tool SDK to the model.

The model contract is:

- respond directly when no tool is needed
- otherwise emit exactly one tool call: `executeJS`
- in gateway mode, the `executeJS` tool description carries the runtime capability contract; there is no separate planner/finalizer prompt layer
- `executeJS` code runs in a shared session scope and must end with an explicit `return`
- `executeJS` code can use `fetch(...)` for outbound HTTP(S) requests and external web access
- `executeJS` code can use `await import("node:fs")` for the Worker virtual filesystem
- persisted globals should stay JSON-serializable

The session mental model is “real REPL-like globals across turns.” Internally, the harness checkpoints and restores serializable state so the behavior survives local executor hops, Dynamic Worker invocations, and cold starts.

Flamecast still speaks plain ACP. The Cloudflare Agent SDK sits underneath that transport:

- Flamecast chooses the runtime session ID
- the runtime provider connects to `/acp/:sessionId`
- the Worker routes that request to `getAgentByName(...)`
- the corresponding `Agent` instance stores the session transcript, compaction summary, and JSON-serializable globals in Durable Object SQLite

The Agent's own protocol/state-sync frames are disabled for ACP connections, so the WebSocket carries ACP NDJSON only.

Context management is deliberately narrow. The only built-in primitive is compaction:

- older transcript entries are summarized when the serialized context crosses `COMPACT_AT_CHARS`
- recent turns are kept verbatim according to `KEEP_RECENT_TURNS`
- the model still sees recent `[User]`, `[Assistant]`, and `[Tool result]` blocks after compaction

`executeJS` is surfaced over ACP as a normal tool call lifecycle:

- `tool_call` when execution starts
- `tool_call_update` while it is running
- final `tool_call_update` with result, logs, and the surviving scope keys

## What Runs Where

Local Miniflare development runs the ACP worker plus a tiny companion HTTP executor on `127.0.0.1`. The Worker itself still uses the Cloudflare Agent SDK locally, with an in-process Durable Object + SQLite state store. The separate executor is only for `executeJS`, because standard Workers disallow string-based code generation and Miniflare does not expose the Dynamic Workers `LOADER` binding.

Deployed Cloudflare Workers keep the same Agent-backed ACP shape, but use the `LOADER` binding from Dynamic Workers so each `executeJS` run executes in a generated worker program instead of in the parent ACP loop.

Persisted session globals should stay JSON-serializable. That is what survives across turns and cold starts.

The deployed worker enables `nodejs_compat`, so `executeJS` can use Cloudflare's virtual `node:fs` support:

- `/tmp` is writable scratch space for a single request
- `/bundle` is read-only bundle content
- `/tmp` contents do not persist across turns, so cross-turn state should still live in session globals instead of the filesystem

## Install

From the repo root:

```bash
pnpm install
```

## Run Locally With Miniflare

Start the example worker:

```bash
pnpm --filter @flamecast/agent-js dev
```

That starts Miniflare and prints:

- the base HTTP URL
- the ACP WebSocket endpoint
- the current agent mode

Useful endpoints:

- `GET /health`
- `WS /acp/:sessionId`

Local dev now auto-switches to `AGENT_MODE=gateway` when `CF_AI_GATEWAY_TOKEN` is available in `examples/agent.js/.env` or the shell. Otherwise it falls back to `scripted`, which gives deterministic `executeJS` behavior for smoke tests.

If you still see the canned scripted reply path locally, the Worker reached the fallback planner. In practice that means one of these is true:

- `CF_AI_GATEWAY_TOKEN` was not loaded
- the gateway is missing a stored upstream provider key
- `OPENAI_API_KEY` is needed locally and was not set

Useful local knobs:

```bash
export COMPACT_AT_CHARS=12000
export KEEP_RECENT_TURNS=6
```

## Run It Through Flamecast Locally

From the repo root, this starts the full dev stack:

```bash
pnpm dev
```

That brings up:

- Flamecast UI at `http://127.0.0.1:3000`
- Flamecast API at `http://127.0.0.1:3001`
- local `agent.js` worker at `http://127.0.0.1:8787`

The current "Add agent template" dialog only captures local subprocess spawn settings, so for now the local `agent.js` runtime should be registered through the Flamecast API:

```bash
curl -X POST http://127.0.0.1:3001/api/agent-templates \
  -H 'content-type: application/json' \
  -d '{
    "name": "Agent.js local",
    "spawn": { "command": "remote-acp", "args": ["agent.js"] },
    "runtime": {
      "provider": "agentjs",
      "baseUrl": "http://127.0.0.1:8787"
    }
  }'
```

Then create a session from that template through the API or UI. The local provider appends the Flamecast session ID automatically and connects to `ws://127.0.0.1:8787/acp/:sessionId`.

## Run The End-to-End Test

```bash
pnpm --filter @flamecast/agent-js test
```

The test starts Miniflare, connects Flamecast’s local runtime client to the worker over ACP/WebSocket, sends two prompts, and verifies that `executeJS` preserves session scope between turns. It also includes a direct ACP reconnect test to confirm that the same `sessionId` resumes the same Agent-backed session state.

## Use AI Gateway With The Vercel AI SDK

Set these environment variables before starting the worker:

```bash
export AGENT_MODE=gateway
export CF_ACCOUNT_ID=...
export CF_AI_GATEWAY=...
export CF_AI_GATEWAY_TOKEN=...
export CF_AI_MODEL=openai/gpt-5.4
```

The worker uses [`ai`](https://www.npmjs.com/package/ai) and [`ai-gateway-provider`](https://www.npmjs.com/package/ai-gateway-provider) only in gateway mode. In scripted mode they stay out of the request path.

## Deploy To Cloudflare

```bash
pnpm --filter @flamecast/agent-js deploy
```

The worker name is `flamecast-agent-js`. The Wrangler config enables both the Agent Durable Object and the Dynamic Workers binding:

```json
{
  "durable_objects": {
    "bindings": [{ "name": "AcpSessionAgent", "class_name": "AcpSessionAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["AcpSessionAgent"] }],
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

The checked-in Wrangler config already sets the non-secret gateway vars for deploy:

- `account_id = c4cf21d8a5e8878bc3c92708b1f80193`
- `AGENT_MODE = gateway`
- `CF_ACCOUNT_ID = c4cf21d8a5e8878bc3c92708b1f80193`
- `CF_AI_GATEWAY = smithery-agent`
- `CF_AI_MODEL = openai/gpt-5.4`

`CF_AI_GATEWAY_TOKEN` should be injected as a secret before deploy:

```bash
source .env
printf %s "$CF_AI_GATEWAY_TOKEN" | pnpm wrangler secret put CF_AI_GATEWAY_TOKEN
```

If the `smithery-agent` gateway does not already have a stored OpenAI key configured, also inject `OPENAI_API_KEY` so unified OpenAI routes like `openai/gpt-5.4` can resolve at runtime:

```bash
printf %s "$OPENAI_API_KEY" | pnpm wrangler secret put OPENAI_API_KEY
```

## Flamecast Integration

The example includes a tiny runtime provider adapter at [`src/runtime-provider.js`](/Users/henry/.codex/worktrees/6f43/flamecast-v2/examples/agent.js/src/runtime-provider.js).

Use it with Flamecast by pointing the provider at the worker base URL or the `/acp` WebSocket base path. The provider appends the Flamecast session ID automatically and connects to `/acp/:sessionId`.

Flamecast now also ships a built-in runtime provider named `agentjs`. Register a template over the Flamecast API with either:

- `runtime.provider = "agentjs"` plus `FLAMECAST_AGENT_JS_BASE_URL` set on the Flamecast server
- or `runtime.provider = "agentjs"` plus `runtime.baseUrl` on the template itself

Example template registration:

```bash
curl -X POST http://localhost:3001/api/agent-templates \
  -H 'content-type: application/json' \
  -d '{
    "name": "Agent.js remote",
    "spawn": { "command": "remote-acp", "args": ["agent.js"] },
    "runtime": {
      "provider": "agentjs",
      "baseUrl": "https://flamecast-agent-js.smithery.workers.dev"
    }
  }'
```
