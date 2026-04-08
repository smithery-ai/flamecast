# flamecast

## 0.7.5

### Patch Changes

- a522eea: Auto-run migrations on fresh install when `.flamecast` directory does not exist

## 0.7.4

### Patch Changes

- Updated dependencies [711d0f1]
  - @flamecast/sdk@0.1.2
  - @flamecast/storage-psql@0.1.2

## 0.7.3

### Patch Changes

- 3548f00: Fix daemon lifecycle: detect stale PID files from recycled PIDs, wait for server to actually start before reporting success, handle port-in-use errors gracefully, report accurate tunnel status, auto-install cloudflared when using --name, and add `flamecast status` command.

## 0.7.2

### Patch Changes

- b1e9fbe: Fix daemon hanging when cloudflared is not installed

  When running `flamecast up --name <name>` on a server without cloudflared, the daemon would hang forever because `ensureCloudflared()` tried to prompt for user confirmation via `readline` on stdin — but in daemon mode stdin is `/dev/null`, so the prompt never resolves. Now detects non-interactive mode and auto-installs cloudflared without prompting.

## 0.7.1

### Patch Changes

- f5e6639: Test changeset release
- Updated dependencies [f5e6639]
  - @flamecast/sdk@0.1.1
  - @flamecast/storage-psql@0.1.1

## 0.7.0

### Minor Changes

- a8b1702: Test publish via changeset

### Patch Changes

- Updated dependencies [a8b1702]
  - @flamecast/sdk@0.1.0
  - @flamecast/storage-psql@0.1.0
