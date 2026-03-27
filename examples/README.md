# Flamecast Examples

## Cloudflare Workers

Deploys Flamecast to Cloudflare Workers with Hyperdrive for Postgres and E2B for sandboxed agent runtimes.

```sh
cd examples/cloudflare
cp .env.example .env   # fill in your credentials
npx wrangler dev
```

**Prerequisites:** The E2B runtime requires the session-host Go binary. It downloads automatically from the `session-host-latest` GitHub release. If you're building a custom binary, set `SESSION_HOST_URL` in `.env` to point to your build. See the [session-host docs in README.md](../README.md#session-host-go-binary) for details.

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
