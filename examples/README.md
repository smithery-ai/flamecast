# Flamecast Examples

## Queue Drain

Fires 5 prompts at an agent and watches the queue drain in real time. Shows serial execution, automatic dequeue, and queue state polling.

```sh
pnpm --filter @flamecast/session-host dev & pnpm --filter @flamecast/example-queue-drain start
```

## Webhooks and Signaling

Demonstrates both event delivery tiers: in-process handlers (Tier 1) and external webhook delivery with HMAC signatures (Tier 2).

```sh
pnpm --filter @flamecast/session-host dev & pnpm --filter @flamecast/example-webhooks-and-signaling start
```
