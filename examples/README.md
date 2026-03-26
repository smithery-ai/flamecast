# Flamecast Examples

Each example demonstrates a different capability of the Flamecast SDK. All examples use the shared config in `examples/shared/` for common setup (agent template, ports, server lifecycle).

## Running Examples

Every example needs the session-host router running alongside. Use `pnpm --filter` to start both:

### Queue Drain

Fires 5 prompts at an agent and watches the queue drain in real time. Shows serial execution, automatic dequeue, and queue state polling.

```sh
pnpm --filter @flamecast/session-host dev & pnpm --filter @flamecast/example-queue-drain start
```

### Webhooks and Signaling

Demonstrates both event delivery tiers: in-process handlers (Tier 1) and external webhook delivery with HMAC signatures (Tier 2).

```sh
pnpm --filter @flamecast/session-host dev & pnpm --filter @flamecast/example-webhooks-and-signaling start
```

## Shared Config

`examples/shared/create-example.ts` exports:

- `AGENT_PATH` — path to the built-in example agent
- `EXAMPLE_TEMPLATE` — default agent template
- `PORTS` — default ports (`flamecast: 3002`, `webhook: 3004`)
- `startServer(flamecast, run, port?)` — starts a Hono server, runs your callback, then shuts down

## Creating a New Example

1. Create `examples/your-example/package.json`:

```json
{
  "name": "@flamecast/example-your-example",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx index.ts"
  },
  "dependencies": {
    "@flamecast/example-shared": "workspace:*",
    "@flamecast/sdk": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.21.0"
  }
}
```

2. Create `examples/your-example/index.ts`:

```ts
import { Flamecast, NodeRuntime } from "@flamecast/sdk";
import { createFlamecastClient } from "@flamecast/sdk/client";
import { EXAMPLE_TEMPLATE, startServer } from "@flamecast/example-shared/create-example.js";

const flamecast = new Flamecast({
  runtimes: { default: new NodeRuntime() },
  agentTemplates: [EXAMPLE_TEMPLATE],
});

await startServer(flamecast, async (apiUrl) => {
  const client = createFlamecastClient({ baseUrl: apiUrl });
  const session = await client.createSession({ agentTemplateId: "example" });
  // ... your demo logic
});
```

3. Run: `pnpm --filter @flamecast/session-host dev & pnpm --filter @flamecast/example-your-example start`
