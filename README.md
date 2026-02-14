# RFC: Flamecast

**Status:** Active Development
**Authors:** Smithery AI
**Last Updated:** 2025

---

## Abstract

Flamecast is an orchestration layer for running background AI coding agents entirely on infrastructure you already own. It dispatches Claude Code as a GitHub Actions workflow, which means the compute runs on GitHub-hosted runners, the code stays in your repositories, the secrets live in your GitHub vault, and the PRs land through your existing review process. Flamecast owns none of the infrastructure. It just wires everything together.

---

## 1. Motivation

Background coding agents are useful. You describe a task in natural language, walk away, and come back to a pull request. But every existing solution asks you to hand over your code, your secrets, or your compute to a third party:

- **Hosted agent platforms** clone your repo onto their servers, run AI on their machines, and push back. You're trusting a vendor with your source code and credentials.
- **Local agent wrappers** run on your laptop. They block your terminal, eat your CPU, and die when you close the lid.
- **Custom CI pipelines** work but require significant setup per repository, with no unified way to dispatch, track, or manage runs across projects.

The core insight behind Flamecast is that most teams already have all the pieces:

| Piece | You already have it |
|---|---|
| Compute | GitHub Actions runners |
| Code hosting | GitHub repositories |
| Secret storage | GitHub Secrets |
| Code review | GitHub Pull Requests |
| AI | Claude Code (via Anthropic) |

Flamecast doesn't replace any of these. It orchestrates them. You bring your own GitHub account, your own Claude Code token, your own repos. Flamecast provides the dispatch mechanism, the tracking UI, and the glue workflow that ties them together into a coherent agent loop.

The result: background agents that run on your infrastructure, governed by your permissions, producing artifacts in your existing workflow. No new infrastructure to provision, no new trust boundaries to evaluate.

---

## 2. How It Works

### 2.1 The Agent Loop

```
User prompt ──► GitHub workflow_dispatch ──► GitHub Actions runner
                                                    │
                                              ┌─────┴──────┐
                                              │ Claude Code │
                                              │  (--print)  │
                                              └─────┬──────┘
                                                    │
                                              commit + push
                                                    │
                                              open/update PR
                                                    │
                                              ◄─── done
```

1. User types a natural-language prompt in the Flamecast UI (or hits the API).
2. Flamecast dispatches a `workflow_dispatch` event to the user's GitHub repository.
3. A GitHub Actions workflow picks it up on an `ubuntu-latest` runner.
4. The workflow checks out the target repo, creates a branch, and runs `claude-code --print` with the prompt.
5. Claude Code reads the codebase, makes changes, and writes them to disk.
6. The workflow commits, pushes, generates a PR description (via a second Claude call), and opens a pull request.
7. The workflow reports its status back to the Flamecast backend.
8. The user sees the result in the UI: logs, status, PR link, merge/close buttons.

### 2.2 Cross-Repository Operations

Flamecast supports a **source repo / target repo** split:

- The **source repo** (typically a dedicated `flamecast` repo) holds the workflow definition and secrets.
- The **target repo** is whatever repository the user wants to modify.

This means you configure secrets once, and can dispatch agents against any repo you have access to. The workflow uses a GitHub PAT (`FLAMECAST_PAT`) to clone and push to the target.

### 2.3 Branch Naming

Branches are deterministically named:

```
flamecast/{github_user}/{prompt_slug}-{sha256_hash_7}
```

This means re-dispatching the same prompt resumes work on the same branch and PR, rather than creating duplicates.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Flamecast UI                       │
│               (Next.js on Vercel)                     │
│                                                      │
│  - Browse repos          - Dispatch workflows        │
│  - View run logs         - Merge/close PRs           │
│  - Manage API keys       - Setup wizard              │
└──────────────┬───────────────────┬───────────────────┘
               │                   │
               │  REST             │  REST (proxy)
               ▼                   ▼
┌──────────────────────┐  ┌────────────────────────────┐
│   GitHub API         │  │   Flamecast Backend        │
│                      │  │   (Hono on Cloudflare      │
│  - Dispatch workflow │  │    Workers)                 │
│  - Fetch run status  │  │                            │
│  - Read logs         │  │  - Register runs           │
│  - Create/merge PRs  │  │  - Track completion        │
│  - Manage secrets    │  │  - Serve run metadata      │
└──────────────────────┘  │  - Infer status from GH    │
                          └─────────────┬──────────────┘
                                        │
                                        │ SQL
                                        ▼
                              ┌──────────────────┐
                              │   PostgreSQL      │
                              │                   │
                              │  - workflow_runs  │
                              │  - oauth_tokens   │
                              │  - api_keys       │
                              │  - source_repos   │
                              └──────────────────┘
```

### 3.1 Frontend — `apps/flamecast`

Next.js 16 app with the App Router. Handles user authentication (WorkOS), GitHub OAuth, and all UI interactions. Talks directly to the GitHub API for dispatching workflows and reading PR status. Proxies to the backend for run tracking.

Key pages:
- **Home** (`/`) — List of repos with recent workflow runs
- **Repo** (`/{owner}/{repo}`) — Trigger form + runs list for a specific repo
- **Run details** (`/{owner}/{repo}/actions/runs/{id}`) — Logs, status, PR actions
- **Settings** (`/settings`) — Setup wizard, API key management

### 3.2 Backend — `apps/flamecast-backend`

Hono API deployed on Cloudflare Workers. Exists primarily because GitHub Actions workflows need a stable endpoint to register and report completion of runs. The backend:

- Receives run registration from the workflow's first step
- Receives completion callbacks from the workflow's last step
- Polls the GitHub API to infer success/failure from job conclusions
- Discovers the created PR by matching the branch name
- Serves run metadata to the frontend

### 3.3 GitHub Action — `action.yml`

A [composite action](https://docs.github.com/en/actions/creating-actions/creating-a-composite-action) published at `smithery-ai/flamecast@v1`. This is the core agent loop:

1. Generate a deterministic branch name from the prompt
2. Checkout the target repository
3. Create or resume the branch
4. Run `npx @anthropic-ai/claude-code --print --dangerously-skip-permissions "$PROMPT"`
5. Commit and push changes
6. Generate a PR description using a second Claude call
7. Open or update the pull request

### 3.4 Database — `packages/db`

PostgreSQL with Drizzle ORM. Four tables in the `flamecast` schema:

| Table | Purpose |
|---|---|
| `workflow_runs` | Tracks every dispatched run: status, prompt, PR URL, timestamps |
| `github_oauth_tokens` | Stores GitHub access/refresh tokens per user |
| `api_keys` | User-generated API keys for backend auth |
| `user_source_repos` | Tracks which repos a user has used as workflow sources |

---

## 4. Trust Model

This is the key design principle. Flamecast introduces **minimal new trust boundaries**:

| Component | Who controls it | What Flamecast sees |
|---|---|---|
| Compute (Actions runner) | GitHub / your org | Nothing — runs in your Actions quota |
| Source code | Your GitHub repo | OAuth-scoped read access for the UI |
| Claude Code token | You (stored in GH Secrets) | Never — the token only exists in the runner environment |
| GitHub PAT | You (stored in GH Secrets) | Never — same as above |
| AI API calls | Anthropic (via your token) | Never — Claude Code talks to Anthropic directly |
| Run metadata | Flamecast backend | Prompt text, repo name, run ID, timestamps, PR URL |

The Flamecast backend sees metadata about your runs (what you asked, which repo, whether it succeeded). It never sees your code, your tokens, or the AI's output. Logs are fetched on-demand from the GitHub API through the user's own OAuth token.

---

## 5. Setup Flow

Flamecast requires three secrets in the user's GitHub repository:

1. **`CLAUDE_CODE_OAUTH_TOKEN`** — Obtained from the [Claude Code console](https://console.anthropic.com). This authorizes Claude Code to call the Anthropic API.
2. **`FLAMECAST_PAT`** — A GitHub Personal Access Token with `repo` scope. Used for cross-repository operations (cloning and pushing to target repos).
3. **`FLAMECAST_API_KEY`** — Auto-generated by Flamecast. Used by the workflow to authenticate with the Flamecast backend when registering/completing runs.

The setup wizard in the UI automates most of this:
1. Creates a dedicated `flamecast` repository in the user's account
2. Walks the user through adding secrets
3. Opens a PR to install the workflow file (`.github/workflows/flamecast.yml`)

---

## 6. Workflow Run Lifecycle

```
                    ┌──────────┐
   dispatch ──────► │ Created  │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │ Running  │ ◄── Claude Code is executing
                    └────┬─────┘
                         │
              ┌──────────┴──────────┐
              │                     │
         ┌────▼─────┐         ┌────▼────┐
         │Completed │         │  Error  │
         │ (PR open)│         │         │
         └──────────┘         └─────────┘
```

**Status inference:** The backend doesn't receive a status directly. Instead, when the workflow reports completion, the backend fetches the GitHub Actions job data and inspects the conclusion of the `flamecast` step:

- `success` → mark `completedAt`
- `failure` / `cancelled` / `timed_out` → mark `errorAt`
- No response after 45 minutes → infer timeout

After a successful run, the backend searches the target repo for a PR matching the deterministic branch name and stores the URL.

---

## 7. API Surface

### 7.1 Backend API (Cloudflare Workers)

Base URL: `https://api.flamecast.dev`
Auth: `Authorization: Bearer {FLAMECAST_API_KEY}`

| Method | Path | Description |
|---|---|---|
| `POST` | `/workflow-runs` | Register a new run (called from GH Actions) |
| `GET` | `/workflow-runs` | List runs for the authenticated user |
| `PATCH` | `/workflow-runs/:id` | Report completion (called from GH Actions) |
| `PATCH` | `/workflow-runs/:id/archive` | Archive a run |
| `PATCH` | `/workflow-runs/:id/unarchive` | Unarchive a run |
| `GET` | `/workflow-runs/github-run` | Proxy: fetch GH workflow run details |
| `GET` | `/workflow-runs/github-run/jobs` | Proxy: fetch GH workflow jobs |
| `GET` | `/workflow-runs/github-run/logs` | Proxy: fetch and parse GH workflow logs |
| `GET` | `/workflow-runs/github-run/outputs` | Proxy: fetch Flamecast outputs artifact |

### 7.2 Frontend API (Next.js)

Internal routes for the web UI — handles GitHub OAuth, workflow dispatch, PR management, setup, and API key CRUD. Not intended for external consumption.

---

## 8. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS 4 | App Router, server components, modern React |
| UI primitives | Radix UI / shadcn | Accessible, composable, unstyled |
| Data fetching | TanStack Query | Cache, polling (5s), optimistic updates |
| Auth | WorkOS AuthKit | Managed auth with GitHub OAuth support |
| Backend | Hono | Fast, edge-native, type-safe routing |
| Edge runtime | Cloudflare Workers | Global, low-latency, serverless |
| Database | PostgreSQL + Drizzle ORM | Relational data, type-safe queries, Zod integration |
| Monorepo | pnpm workspaces + Turborepo | Shared types, cached builds, single dependency tree |
| Code quality | Biome | Fast formatter + linter, replaces ESLint + Prettier |
| Analytics | PostHog | Product analytics, event tracking |
| AI | Claude Code (`@anthropic-ai/claude-code`) | Agentic coding via CLI |
| CI/CD | GitHub Actions (composite action) | The actual agent runtime |

---

## 9. Repository Structure

```
sacramento/
├── action.yml                          # The composite GitHub Action (the agent loop)
├── apps/
│   ├── flamecast/                      # Next.js web application
│   │   ├── app/                        # Pages and API routes (App Router)
│   │   ├── components/                 # React components
│   │   ├── hooks/                      # TanStack Query hooks
│   │   └── lib/                        # Server utilities, GitHub client, auth
│   └── flamecast-backend/              # Hono API on Cloudflare Workers
│       └── src/routes/                 # API route handlers
├── packages/
│   ├── db/                             # Drizzle ORM schemas and migrations
│   ├── flamecast/                      # Shared Zod schemas and CLI
│   ├── utils/                          # Logger, URL helpers, OpenAPI utils
│   └── typescript-config/              # Shared tsconfig presets
├── turbo.json                          # Turborepo pipeline config
├── pnpm-workspace.yaml                 # Workspace package list
└── biome.jsonc                         # Biome formatter/linter config
```

---

## 10. Development

```bash
# Install dependencies
pnpm install

# Pull environment variables from Infisical
pnpm secrets:pull

# Push database schema
cd packages/db && pnpm db:push

# Start everything (frontend :6969, backend :6970)
pnpm dev

# Format and lint
pnpm fmt

# Type check
pnpm typecheck

# Build all packages
pnpm build
```

---

## 11. Design Decisions

### Why a composite action, not a marketplace action?

Composite actions are just shell scripts checked into a repo. They're transparent, forkable, and versioned with git tags. Users can read exactly what runs. There's no opaque Docker container or JavaScript bundle.

### Why a separate backend instead of just Next.js API routes?

GitHub Actions workflows need to POST to a stable endpoint during execution. The backend is purpose-built for this: receive registration, receive completion, infer status. Keeping it on Cloudflare Workers means it's globally fast and scales to zero when idle.

### Why dispatch to GitHub Actions instead of running locally?

The whole point. GitHub Actions runners are ephemeral, sandboxed, and already provisioned. The user's laptop stays free. The agent can run for 30 minutes without blocking anything. And the code never leaves GitHub's infrastructure.

### Why a dedicated `flamecast` repo per user?

Secrets are scoped to repositories in GitHub. A dedicated repo serves as the central dispatch point: configure secrets once, dispatch workflows against any target repo. It also keeps the Flamecast workflow file out of your actual project repos.

### Why two Claude calls per run?

The first call (`--print`) does the actual coding work. The second call generates the PR description by reviewing the diff. This produces higher-quality PR descriptions because the model can focus entirely on summarizing changes rather than writing code and describing it simultaneously.

---

## 12. Limitations and Future Work

**Current limitations:**
- Polling-based status updates (5-second interval in the UI, no webhooks yet)
- Single-shot agent — no iterative feedback loop or human-in-the-loop during a run
- 30-minute timeout per run (GitHub Actions limit for public repos)
- Logs are fetched on-demand and truncated (300k chars for workflow logs, 200k for Claude logs)
- No team/organization support — runs are scoped to individual users

**Potential future directions:**
- GitHub webhook receiver for real-time status updates (eliminate polling)
- Iterative runs — agent reviews CI results and self-corrects
- Team workspaces with shared repos and run history
- Run analytics — success rates, duration trends, common failure modes
- Local dispatch via CLI (`ff` binary in `packages/flamecast`)
- Custom agent configurations (model selection, system prompts, tool restrictions)

---

## 13. Security Considerations

- **Tokens never transit Flamecast servers.** `CLAUDE_CODE_OAUTH_TOKEN` and `FLAMECAST_PAT` are GitHub Secrets, injected into the runner environment by GitHub. The Flamecast backend never sees them.
- **OAuth tokens are stored encrypted at rest** in the database, scoped per user, and used only server-side for GitHub API calls in the UI.
- **API keys are UUIDs** with high entropy, user-scoped, and revocable from the settings page.
- **The composite action runs `--dangerously-skip-permissions`** on Claude Code, which means the AI can execute arbitrary commands on the runner. This is acceptable because GitHub Actions runners are ephemeral and sandboxed — they're destroyed after the job completes.
- **Cross-repo operations require explicit PAT configuration** by the user, ensuring the user consciously grants access.

---

## Summary

Flamecast is a thin orchestration layer, not an infrastructure provider. It dispatches Claude Code as a GitHub Actions workflow, tracks the result, and gives you a UI to manage everything. Your code stays on GitHub. Your compute runs on GitHub Actions. Your AI calls go through your own Anthropic token. Flamecast just connects the dots.
