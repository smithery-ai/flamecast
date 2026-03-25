# 5.1 — Deploy

**Goal:** Working cloud deployment with pluggable runtime. SDK is runtime-agnostic.

**Depends on:** All previous phases

## What to do

### Publish SessionHost image

```bash
docker build -t ghcr.io/smithery-ai/flamecast-session-host:latest packages/session-host
docker push ghcr.io/smithery-ai/flamecast-session-host:latest
```

### Template seeding for deployed runtimes

```bash
SEED_RUNTIME=fly DATABASE_URL=... pnpm db:seed
```

Templates with `provider: "fly"` dispatch to FlyRuntime. Templates with `provider: "local"` dispatch to LocalRuntime. A single instance can have both.

### Example: deploy with Fly Machines

```typescript
import { FlyRuntime } from "@flamecast/runtime-fly"; // separate package

const flamecast = new Flamecast({
  storage: await createPsqlStorage({ url: process.env.DATABASE_URL }),
  runtimes: {
    fly: new FlyRuntime({ app: "flamecast-session-host", token: process.env.FLY_API_TOKEN! }),
  },
});
```

### Example: deploy with E2B

```typescript
import { E2BRuntime } from "@flamecast/runtime-e2b"; // separate package

const flamecast = new Flamecast({
  storage: await createPsqlStorage({ url: process.env.DATABASE_URL }),
  runtimes: {
    e2b: new E2BRuntime({ apiKey: process.env.E2B_API_KEY! }),
  },
});
```

### CI/CD

```yaml
- name: Build SessionHost image
  run: docker build -t ghcr.io/smithery-ai/flamecast-session-host packages/session-host
- name: Push SessionHost image
  run: docker push ghcr.io/smithery-ai/flamecast-session-host
- name: Deploy API
  run: pnpm alchemy:deploy
```

## Files

- CI/CD config
- Runtime package examples (separate repos/packages)

## Test Coverage

No automated tests — deployment is verified by manual smoke test or CI health check against the deployed endpoint.

## Acceptance criteria

- SessionHost image published and runnable
- Deployed control plane serves API
- Sessions create and run on configured runtime
