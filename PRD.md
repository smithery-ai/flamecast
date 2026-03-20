# PRD: Flamecast

## What is Flamecast?

Flamecast is an open-source ACP (Agent Client Protocol) orchestrator. It provides a simple API to run, observe, and control AI coding agents — whether that's Codex, Claude Code, or any ACP-compatible agent. A bundled web UI ships as a reference frontend, but the core offering is the API itself.

## Problem

AI coding agents (Codex, Claude Code, etc.) are powerful but each has its own CLI, its own session model, and its own permission flow. There's no standard programmatic way to:

- Spin up agent sessions and send prompts via an API
- Manage tool permissions programmatically or from any client
- Query session history and logs
- Run multiple agents concurrently behind a unified interface
- Deploy agent orchestration to your own infrastructure (cloud, on-prem, local)

If you want to build on top of these agents — a custom UI, a CI integration, a multi-agent workflow — you're wrapping CLIs or reimplementing orchestration from scratch.

## Solution

Flamecast is an ACP orchestrator that exposes agent management as an HTTP API. It handles connection lifecycle, ACP protocol negotiation, permission brokering, and session state — so consumers only deal with simple REST calls.

1. **An API** to create connections, send prompts, respond to permissions, and query logs. Any HTTP client can drive it — a web app, a CLI, a script, another service.
2. **A pluggable orchestrator** that manages agent lifecycles, transports, and state persistence behind that API.
3. **Deploy-anywhere architecture** — run locally with `npx flamecast`, deploy to Vercel, Cloudflare, K8s, or any platform that can run Node.
4. **A bundled web UI** as a reference client and out-of-the-box dashboard for developers who want a visual interface.

## Target users

- **Developers who want full control over their agent UX** — not locked into someone else's GUI. Use the bundled UI, build your own, or drive agents from scripts and pipelines. The API is the interface; the experience is yours to design.
- **Teams** who want to run agents in sandboxed environments with shared visibility and programmatic control.
- **Platform builders** who want to embed agent orchestration into their own products using Flamecast as a library or backing service.

## Usage modes

### 1. Local CLI (`npx flamecast`)

The zero-config experience. Run it from any project directory — it starts the API server and opens the bundled UI. Agents run as local child processes. State persists in an embedded PGLite database under `.acp/pglite`.

Any HTTP client can hit the API at `localhost:3001/api`. The bundled UI is one such client.

### 2. Custom config (`index.ts`)

Write a small entry file that configures Flamecast for your setup — your provisioner, your state manager, your infra. Build it, link it, and use the CLI from any directory just like you would with the default `npx flamecast`.

```ts
// src/index.ts
import { Flamecast } from "flamecast";

const flamecast = new Flamecast({
  stateManager: "psql",
  provisioner: "docker",
});

flamecast.listen(3001);
```

```bash
# Build and link your custom Flamecast
npm run build && npm link

# Now use it from any project directory — same CLI, your config
cd ~/projects/my-app
flamecast
```

This is the same `npx flamecast` experience — API server starts, bundled UI is available — but backed by your provisioner and state manager. No forking the repo, no config files to discover. Just a TypeScript entry file you own, built into a CLI you can use globally.

The same entry file works for deployment. Export `.fetch` for serverless, or call `.listen()` for a long-running server:

```ts
// Vercel / Cloudflare — export the fetch handler
export default flamecast.fetch;
```

Flamecast is a class that produces a standard `fetch` handler. This makes it embeddable in any framework (Next.js API routes, Cloudflare Workers, Express, Fastify — anything that speaks `Request`/`Response`).

### 3. Any chat medium via Vercel Chat SDK

Flamecast integrates with the [Vercel Chat SDK](https://chat-sdk.dev/) as a first-class config option. Chat SDK is a unified TypeScript framework for building bots across Slack, Discord, Microsoft Teams, WhatsApp, Telegram, GitHub, Linear, and Google Chat. Pass your Chat SDK adapters into the Flamecast constructor and it handles the wiring — messages from any platform become prompts to your agent, responses go back to the thread, and permission requests surface as interactive approve/deny buttons native to that platform.

```ts
import { Flamecast } from "flamecast";
import { SlackAdapter } from "@vercel/chat-sdk/adapters/slack";
import { DiscordAdapter } from "@vercel/chat-sdk/adapters/discord";

const flamecast = new Flamecast({
  stateManager: "psql",
  provisioner: "docker",
  chat: {
    adapters: [
      new SlackAdapter({ token: process.env.SLACK_TOKEN }),
      new DiscordAdapter({ token: process.env.DISCORD_TOKEN }),
    ],
  },
});

flamecast.listen(3001);
```

That's it. Your coding agent is now reachable from Slack, Discord, and the bundled web UI simultaneously — same orchestration, same permissions, same logs. The agent doesn't know or care which surface the user is on.

## API surface

The API is the product. All operations are available as REST endpoints:

| Method   | Endpoint                                      | Description                           |
| -------- | --------------------------------------------- | ------------------------------------- |
| `GET`    | `/api/agent-processes`                        | List available agent definitions      |
| `POST`   | `/api/agent-processes`                        | Register a custom agent               |
| `GET`    | `/api/connections`                            | List active connections               |
| `POST`   | `/api/connections`                            | Create a new connection (spawn agent) |
| `GET`    | `/api/connections/:id`                        | Get connection details + logs         |
| `POST`   | `/api/connections/:id/prompt`                 | Send a prompt to the agent            |
| `POST`   | `/api/connections/:id/permissions/:requestId` | Respond to a permission request       |
| `DELETE` | `/api/connections/:id`                        | Kill a connection                     |

The bundled web UI is a React app that calls these endpoints. It's a consumer of the API, not the API itself.

## Core concepts

### Connections

A connection is a live ACP session between Flamecast and an agent process. It has:

- An agent (what's running — Codex, Claude Code, a custom agent)
- A transport (how Flamecast talks to it — stdio, TCP, container exec)
- A session (ACP session ID, conversation history)
- Permissions (pending approval/denial of agent tool calls)

### Agent processes

Registered definitions of how to spawn an agent. Built-in presets (Example agent, Codex) ship with Flamecast. Users can register custom agents via the API.

### State manager

Pluggable persistence for connection metadata and logs. Implementations:

- **Memory** — in-process, lost on restart. Good for dev/testing.
- **Postgres** — durable. PGLite (embedded, zero-config) or external Postgres via URL.
- Future: Convex, SQLite, etc. — the interface is stable, implementations are swappable.

### Provisioner

Pluggable agent lifecycle management. Implementations:

- **Local** — `child_process.spawn()`. Current default. Works for `npx flamecast`.
- **Docker** — spawn agents in containers. Sandboxed, resource-limited.
- **Kubernetes** — spawn agents as K8s jobs/pods. Production-scale isolation.
- **Remote** — connect to an agent already running elsewhere via TCP/HTTP.

The provisioner determines whether Flamecast can run in a serverless environment. Local provisioner requires a long-running process. Docker/K8s/Remote provisioners decouple agent lifetime from the orchestrator process, enabling serverless deployment.

## Landscape: how Flamecast differs

Several products occupy adjacent space. The key distinction is **what layer they operate at**.

### Agent GUIs: Conductor, Superset, T3 Code

These are all **frontends for coding agents** — apps you sit in front of to interact with agents more comfortably.

- **Conductor** (conductor.build) — Mac desktop app. Creates parallel Claude Code / Codex agents in isolated Git worktrees, native GUI for review and merge. macOS only.
- **Superset** (superset.sh) — Desktop IDE / terminal (macOS, Windows, Linux). Runs any CLI agent (Claude Code, Codex, Aider, OpenCode) in parallel worktrees with persistent sessions, port forwarding, IDE deep-linking. YC-backed, open source (Elastic License 2.0).
- **T3 Code** (t3.codes) — Open-source web GUI for coding agents. Minimal chat interface with markdown rendering, visual diffs, worktree support, and remote access. Currently Codex-first, Claude Code support coming. Built by Theo / ping.gg.

All three are **opinionated experiences** — they decide what the UI looks like, how you interact with agents, and where everything runs (your machine). They're great if their UX fits your workflow. But if you want something different — a custom dashboard, a Slack bot, a CI integration, a completely different interaction model — you can't get there from these tools. There's no API underneath.

**How Flamecast differs:** Flamecast is the **layer below the UX**. It's a server and API that handles orchestration, and you build whatever experience you want on top. The bundled web UI is one possible frontend — but so is a CLI, a mobile app, a VS Code extension, a CI pipeline, or a multi-tenant SaaS. Conductor / Superset / T3 Code give you _their_ experience. Flamecast gives you the primitives to build _yours_.

They also can't be deployed — they're local-only. Flamecast runs on Vercel, Cloudflare, K8s, or any infra you choose. And because it's an API, it plugs directly into tools like the Vercel Chat SDK to bring your agents into Slack, Discord, Teams, WhatsApp, or any messaging platform — something no desktop GUI can do.

### OpenClaw (openclaw.ai)

OpenClaw is an open-source **personal AI assistant** that runs locally and connects to chat apps (WhatsApp, Telegram, Slack, etc.) as its interface. It's a general-purpose automation agent — browser control, file management, email, calendar, 50+ integrations — not coding-specific. You talk to it through messaging apps, and it executes tasks on your machine.

**How Flamecast differs:** OpenClaw is an **agent itself** — a general-purpose assistant you interact with directly. Flamecast is an **orchestrator for coding agents** — it doesn't do the work, it manages the things that do. OpenClaw replaces your workflow with an AI assistant. Flamecast gives you an API to control existing coding agents (Codex, Claude Code, etc.) and deploy that control layer to your own infrastructure. Different layer, different purpose.

### Summary

|                        | Flamecast                         | Agent GUIs (Conductor, Superset, T3 Code) | OpenClaw                          |
| ---------------------- | --------------------------------- | ----------------------------------------- | --------------------------------- |
| **What it is**         | Orchestration API + server        | Desktop apps / web GUIs for agents        | Personal AI assistant             |
| **Core interface**     | HTTP API (`.fetch` / `.listen`)   | Native GUI or local web UI                | Chat apps (WhatsApp, Slack, etc.) |
| **Primary user**       | Platform builders, teams, infra   | Individual developers                     | Anyone (non-technical OK)         |
| **Runs where**         | Anywhere (local, serverless, K8s) | Local machine only                        | Local machine only                |
| **Embeddable**         | Yes (library import)              | No                                        | No                                |
| **Deployable**         | Yes (Vercel, CF, K8s, VPS)        | No                                        | No                                |
| **Agent relationship** | Orchestrates ACP agents           | Wraps CLI agents in a UI                  | Is the agent                      |
| **Protocol**           | ACP (Agent Client Protocol)       | CLI stdio                                 | Custom / LLM tool-use             |
| **Coding-specific**    | Yes                               | Yes                                       | No (general automation)           |

The short version: Conductor, Superset, and T3 Code give you **their UI for agents**. OpenClaw **is** an agent. Flamecast gives you an **API to build your own agent experience** — and deploy it anywhere.

## Non-goals (for now)

- **Auth/multi-tenancy** — Flamecast does not handle user authentication or tenant isolation. It's single-tenant by design today. Auth is an integration concern for whoever deploys it.
- **Agent implementation** — Flamecast doesn't include or build agents. It orchestrates existing ACP-compatible agents.
- **Real-time streaming** — Currently poll-based. WebSocket/SSE streaming is a future enhancement, not a blocker.
- **Opinionated frontend** — The bundled UI is a reference implementation. Flamecast is not a UI product; it's an orchestration API that happens to ship with one.

## Success criteria

1. A developer can run `npx flamecast` and have a working agent session — via the bundled UI or a `curl` command — within 30 seconds.
2. The same Flamecast codebase can be deployed to Vercel (serverless), a Docker container, or a K8s cluster with only config changes — no code forks.
3. Swapping the agent (Codex to Claude Code to a custom agent) requires changing one line (the agent process definition), not the orchestration layer.
4. A platform builder can `import { Flamecast } from "flamecast"` and have a fully functional agent orchestration API in their app without adopting the bundled UI.
