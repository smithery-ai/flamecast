# `@flamecast/example-agent-js`

This example runs a Flamecast-compatible ACP agent as a Cloudflare Worker.

It keeps the harness minimal:

- ACP over WebSocket at `/acp`
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
- `executeJS` code runs in a shared session scope and must end with an explicit `return`
- persisted globals should stay JSON-serializable

The session mental model is “real REPL-like globals across turns.” Internally, the harness checkpoints and restores serializable state so the behavior survives local executor hops, Dynamic Worker invocations, and cold starts.

Context management is deliberately narrow. The only built-in primitive is compaction:

- older transcript entries are summarized when the serialized context crosses `COMPACT_AT_CHARS`
- recent turns are kept verbatim according to `KEEP_RECENT_TURNS`
- the model still sees recent `[User]`, `[Assistant]`, and `[Tool result]` blocks after compaction

`executeJS` is surfaced over ACP as a normal tool call lifecycle:

- `tool_call` when execution starts
- `tool_call_update` while it is running
- final `tool_call_update` with result, logs, and the surviving scope keys

## What Runs Where

Local Miniflare development runs the ACP worker plus a tiny companion HTTP executor on `127.0.0.1`. That is necessary because standard Workers disallow string-based code generation and Miniflare does not expose the Dynamic Workers `LOADER` binding.

Deployed Cloudflare Workers use the `LOADER` binding from Dynamic Workers, so each `executeJS` run executes in a generated worker program instead of in the parent ACP loop.

Persisted session globals should stay JSON-serializable. That is what survives across turns and cold starts.

## Install

From the repo root:

```bash
pnpm install
```

## Run Locally With Miniflare

Start the example worker:

```bash
pnpm --filter @flamecast/example-agent-js dev
```

That starts Miniflare and prints:

- the base HTTP URL
- the ACP WebSocket endpoint
- the current agent mode

Useful endpoints:

- `GET /health`
- `WS /acp`

By default local dev uses `AGENT_MODE=scripted`, which gives deterministic `executeJS` behavior for smoke tests.

Useful local knobs:

```bash
export COMPACT_AT_CHARS=12000
export KEEP_RECENT_TURNS=6
```

## Run The End-to-End Test

```bash
pnpm --filter @flamecast/example-agent-js test
```

The test starts Miniflare, connects Flamecast’s local runtime client to the worker over ACP/WebSocket, sends two prompts, and verifies that `executeJS` preserves session scope between turns.

## Use AI Gateway With The Vercel AI SDK

Set these environment variables before starting the worker:

```bash
export AGENT_MODE=gateway
export CF_ACCOUNT_ID=...
export CF_AI_GATEWAY=...
export CF_AI_GATEWAY_TOKEN=...
export CF_AI_MODEL=openai/gpt-5.2
```

The worker uses [`ai`](https://www.npmjs.com/package/ai) and [`ai-gateway-provider`](https://www.npmjs.com/package/ai-gateway-provider) only in gateway mode. In scripted mode they stay out of the request path.

## Deploy To Cloudflare

```bash
pnpm --filter @flamecast/example-agent-js deploy
```

The worker name is `flamecast-agent-js`. The Wrangler config enables the Dynamic Workers binding:

```json
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

If you want the deployed worker to use AI Gateway instead of scripted mode, set the same `CF_*` vars in Cloudflare before deploying.

## Flamecast Integration

The example includes a tiny runtime provider adapter at [`src/runtime-provider.js`](/Users/henry/.codex/worktrees/6f43/flamecast-v2/examples/agent.js/src/runtime-provider.js).

Use it with Flamecast by pointing the provider at the worker’s `/acp` WebSocket endpoint.
