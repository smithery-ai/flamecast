# Flamecast

> **Early alpha** — APIs and features may change without notice.

Flamecast lets you access your computer from anywhere through a web browser.

## Quick start

```bash
npx flamecast@latest up --name yourname
```

Then open **yourname.flamecast.app** in any browser.

<details>
<summary>Docker</summary>

Build the included image from this checkout as `flamecast` if you want Flamecast, Node, Go, `cloudflared`, Claude Code, and Codex preinstalled:

```bash
docker build -t flamecast .
```

The image defaults to `flamecast up` in the foreground, so you can pass `up` flags directly without opening a shell:

```bash
docker run --rm -v "$PWD:/workspace" -p 3001:3001 flamecast
docker run --rm -v "$PWD:/workspace" flamecast --name yourname
docker run --rm -v "$PWD:/workspace" flamecast --port 4000 --name yourname
```

Bind your project into `/workspace` if you want agents to read and write local files. Without that mount, Flamecast runs with an empty workspace.

When you run Flamecast this way, manage it with Docker commands like `docker logs` and `docker stop`. A separate `docker run flamecast status` container will not see the process from another container.

To inspect the container directly, override the default command:

```bash
docker run --rm -it -v "$PWD:/workspace" flamecast bash
```

### Persist agent auth

Keep agent auth state on mounted volumes instead of baking credentials into the image:

```bash
docker run --rm \
  -v "$PWD:/workspace" \
  -v flamecast-data:/root/.flamecast \
  -v codex-data:/root/.codex \
  -v claude-data:/root/.claude \
  flamecast --name yourname
```

For Codex CLI in a container, prefer file-based credential storage so login survives restarts:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v codex-data:/root/.codex \
  flamecast bash
mkdir -p /root/.codex
printf 'cli_auth_credentials_store = "file"\n' > /root/.codex/config.toml
codex login
```

If the container is headless, you can also copy a trusted `auth.json` into `/root/.codex/auth.json`.

For Claude Code on Linux, credentials live in `/root/.claude/.credentials.json`. For non-interactive runs, pass a token at runtime instead of storing it in the image:

```bash
docker run --rm \
  -v "$PWD:/workspace" \
  -v claude-data:/root/.claude \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  flamecast --name yourname
```

For an interactive Claude login flow:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v claude-data:/root/.claude \
  flamecast bash
claude
/login
```

</details>

## How it works

Flamecast runs a lightweight agent on your machine and connects it to a web UI through a relay. The relay only brokers the connection — **your data stays on your machine** and is never stored or inspected by Flamecast servers. The entire stack is open-source and can run fully on your own infrastructure if you prefer.

## Links

- [Agent Client Protocol (ACP)](https://agentclientprotocol.com/)
- [Alchemy](https://alchemy.run)
