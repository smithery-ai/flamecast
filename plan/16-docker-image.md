# 4.1 — SessionHost Docker Image

**Goal:** Publish a universal SessionHost Docker image for remote runtimes.

**Depends on:** Nothing (parallel with other Phase 4 units)

## What to do

Update `packages/session-host/Dockerfile`:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY packages/session-host/dist/ ./
COPY packages/session-host/package.json ./
RUN npm install --production
ENV SESSION_HOST_PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
```

Build and push:

```bash
docker build -t ghcr.io/smithery-ai/flamecast-session-host:latest packages/session-host
docker push ghcr.io/smithery-ai/flamecast-session-host:latest
```

This image works on Fly Machines, E2B, Daytona, CF Containers, plain Docker.

## Files

- **Modify:** `packages/session-host/Dockerfile`

## Test Coverage

Integration tests (can run in CI with Docker available):

- **Image builds:** `docker build` exits 0
- **Container starts:** `docker run` → `GET /health` returns `{ status: "idle" }`
- **Session lifecycle in container:** `POST /start` with a simple echo agent → verify `{ hostUrl, websocketUrl }` returned → WS connect → events flow

## Acceptance criteria

- Image builds
- `docker run -e SESSION_HOST_PORT=8080 flamecast-session-host` starts and responds to `GET /health`
